import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { defaultInstructions } from '@/config/instructions/index.js';
import { isUniqueViolation, PrismaService } from '../prisma/prisma.service.js';

export type InstructionView = {
  name: string;
  content: string;
  source: 'custom' | 'default';
  version: number | null;
  updatedAt: Date | null;
};

type Row = { name: string; content: string; version: number; updatedAt: Date };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A helper reads its instructions on every model call, so keep them briefly in memory.
// Another server sees an edit within this time.
const CACHE_MS = 5_000;

//1. A saved custom version wins. Without one, the default file in src/config/instructions is used.
//2. Every write is one statement. Update and delete need the version you read, so two
//   people editing at once cannot overwrite each other.
@Injectable()
export class InstructionsService {
  private readonly cache = new Map<string, { content: string; at: number }>();
  private readonly logger = new Logger(InstructionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async list(): Promise<InstructionView[]> {
    const rows: Row[] = this.stored()
      ? await this.prisma.db.instruction.findMany({ orderBy: { name: 'asc' } })
      : [];
    const names = new Set([
      ...Object.keys(defaultInstructions),
      ...rows.map((row) => row.name),
    ]);
    return [...names].sort().map((name) =>
      view(
        name,
        rows.find((row) => row.name === name),
      ),
    );
  }

  async get(name: string): Promise<InstructionView> {
    checkName(name);
    const row = this.stored()
      ? await this.prisma.db.instruction.findUnique({ where: { name } })
      : null;
    if (!row && defaultInstructions[name] === undefined)
      throw new NotFoundException(`No instructions named ${name}.`);
    return view(name, row ?? undefined);
  }

  async create(name: string, content: string): Promise<InstructionView> {
    checkName(name);
    this.requireStore();
    try {
      const row = await this.prisma.db.instruction.create({
        data: { name, content },
      });
      this.cache.delete(name);
      return view(name, row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          `Custom instructions named ${name} already exist. Update them instead.`,
        );
      throw error;
    }
  }

  async update(
    name: string,
    content: string,
    version: number,
  ): Promise<InstructionView> {
    checkName(name);
    this.requireStore();
    const { count } = await this.prisma.db.instruction.updateMany({
      where: { name, version },
      data: { content, version: { increment: 1 } },
    });
    if (count !== 1) await this.missingOrStale(name);
    this.cache.delete(name);
    return await this.get(name);
  }

  // Removes the custom version. Returns what the helper uses now: the default, or nothing.
  async remove(
    name: string,
    version: number,
  ): Promise<InstructionView | undefined> {
    checkName(name);
    this.requireStore();
    const { count } = await this.prisma.db.instruction.deleteMany({
      where: { name, version },
    });
    if (count !== 1) await this.missingOrStale(name);
    this.cache.delete(name);
    return defaultInstructions[name] === undefined
      ? undefined
      : view(name, undefined);
  }

  //1. Pass this as a helper's instructions. The SDK calls it before each model call.
  //2. Only names with a default file are allowed, so a deleted custom version always falls back.
  forAgent(name: string) {
    if (defaultInstructions[name] === undefined)
      throw new Error(`Add a default file for ${name} before using it.`);
    return () => this.content(name);
  }

  // If the database is down, the last text this server saw is used, then the default.
  async content(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.content;
    let content = defaultInstructions[name];
    if (this.stored()) {
      try {
        const row = await this.prisma.db.instruction.findUnique({
          where: { name },
          select: { content: true },
        });
        if (row) content = row.content;
      } catch {
        this.logger.warn(
          `Instructions for ${name} could not be read; using the last known text.`,
        );
        if (cached) return cached.content;
      }
    }
    if (content === undefined)
      throw new Error(`No instructions named ${name}.`);
    this.cache.set(name, { content, at: Date.now() });
    return content;
  }

  private async missingOrStale(name: string): Promise<never> {
    const row = await this.prisma.db.instruction.findUnique({
      where: { name },
      select: { version: true },
    });
    if (!row)
      throw new NotFoundException(`No custom instructions named ${name}.`);
    throw new ConflictException(
      `These instructions changed. Reload version ${row.version} and try again.`,
    );
  }

  private stored() {
    return Boolean(this.config.get<string>('DATABASE_URL'));
  }

  private requireStore() {
    if (!this.stored())
      throw new ServiceUnavailableException(
        'Saving instructions needs DATABASE_URL.',
      );
  }
}

function checkName(name: string) {
  if (!NAME.test(name))
    throw new BadRequestException(
      'A name uses lowercase letters, numbers, and dashes, up to 64 characters.',
    );
}

function view(name: string, row: Row | undefined): InstructionView {
  return row
    ? {
        name,
        content: row.content,
        source: 'custom',
        version: row.version,
        updatedAt: row.updatedAt,
      }
    : {
        name,
        content: defaultInstructions[name],
        source: 'default',
        version: null,
        updatedAt: null,
      };
}
