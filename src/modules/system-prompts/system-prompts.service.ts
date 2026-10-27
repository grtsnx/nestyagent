import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { defaultSystemPrompts } from '@/config/system-prompts/index.js';
import {
  isUniqueViolation,
  PrismaService,
} from '@/lib/prisma/prisma.service.js';

export type SystemPromptView = {
  name: string;
  content: string;
  source: 'custom' | 'default';
  version: number | null;
  updatedAt: Date | null;
};

type Row = { name: string; content: string; version: number; updatedAt: Date };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A helper reads its system prompt on every model call, so keep them briefly in memory.
// Another server sees an edit within this time.
const CACHE_MS = 5_000;

//1. A saved custom version wins. Without one, the default file in src/config/system-prompts is used.
//2. Every write is one statement. Update and delete need the version you read, so two
//   people editing at once cannot overwrite each other.
@Injectable()
export class SystemPromptsService {
  private readonly cache = new Map<string, { content: string; at: number }>();
  private readonly logger = new Logger(SystemPromptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async list(): Promise<SystemPromptView[]> {
    const rows: Row[] = this.stored()
      ? await this.prisma.db.systemPrompt.findMany({ orderBy: { name: 'asc' } })
      : [];
    const names = new Set([
      ...Object.keys(defaultSystemPrompts),
      ...rows.map((row) => row.name),
    ]);
    return [...names].sort().map((name) =>
      view(
        name,
        rows.find((row) => row.name === name),
      ),
    );
  }

  async get(name: string): Promise<SystemPromptView> {
    checkName(name);
    const row = this.stored()
      ? await this.prisma.db.systemPrompt.findUnique({ where: { name } })
      : null;
    if (!row && defaultSystemPrompts[name] === undefined)
      throw new NotFoundException(`No system prompt named ${name}.`);
    return view(name, row ?? undefined);
  }

  async create(name: string, content: string): Promise<SystemPromptView> {
    checkName(name);
    this.requireStore();
    try {
      const row = await this.prisma.db.systemPrompt.create({
        data: { name, content },
      });
      this.cache.delete(name);
      return view(name, row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          `A custom system prompt named ${name} already exists. Update it instead.`,
        );
      throw error;
    }
  }

  async update(
    name: string,
    content: string,
    version: number,
  ): Promise<SystemPromptView> {
    checkName(name);
    this.requireStore();
    const { count } = await this.prisma.db.systemPrompt.updateMany({
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
  ): Promise<SystemPromptView | undefined> {
    checkName(name);
    this.requireStore();
    const { count } = await this.prisma.db.systemPrompt.deleteMany({
      where: { name, version },
    });
    if (count !== 1) await this.missingOrStale(name);
    this.cache.delete(name);
    return defaultSystemPrompts[name] === undefined
      ? undefined
      : view(name, undefined);
  }

  //1. Pass this as a helper's system prompt. The SDK calls it before each model call.
  //2. Only names with a default file are allowed, so a deleted custom version always falls back.
  forAgent(name: string) {
    if (defaultSystemPrompts[name] === undefined)
      throw new Error(`Add a default file for ${name} before using it.`);
    return () => this.content(name);
  }

  // If the database is down, the last text this server saw is used, then the default.
  async content(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.content;
    let content = defaultSystemPrompts[name];
    if (this.stored()) {
      try {
        const row = await this.prisma.db.systemPrompt.findUnique({
          where: { name },
          select: { content: true },
        });
        if (row) content = row.content;
      } catch {
        this.logger.warn(
          `The system prompt for ${name} could not be read; using the last known text.`,
        );
        if (cached) return cached.content;
      }
    }
    if (content === undefined)
      throw new Error(`No system prompt named ${name}.`);
    this.cache.set(name, { content, at: Date.now() });
    return content;
  }

  private async missingOrStale(name: string): Promise<never> {
    const row = await this.prisma.db.systemPrompt.findUnique({
      where: { name },
      select: { version: true },
    });
    if (!row)
      throw new NotFoundException(`No custom system prompt named ${name}.`);
    throw new ConflictException(
      `This system prompt changed. Reload version ${row.version} and try again.`,
    );
  }

  private stored() {
    return Boolean(this.config.get<string>('DATABASE_URL'));
  }

  private requireStore() {
    if (!this.stored())
      throw new ServiceUnavailableException(
        'Saving a system prompt needs DATABASE_URL.',
      );
  }
}

function checkName(name: string) {
  if (!NAME.test(name))
    throw new BadRequestException(
      'A name uses lowercase letters, numbers, and dashes, up to 64 characters.',
    );
}

function view(name: string, row: Row | undefined): SystemPromptView {
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
        content: defaultSystemPrompts[name],
        source: 'default',
        version: null,
        updatedAt: null,
      };
}
