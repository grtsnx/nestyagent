import { readFileSync } from 'node:fs';

//1. The built-in system prompt for each helper, read once from the Markdown file beside this one.
//2. A custom version saved through the API wins. Deleting it brings this default back.
export const defaultSystemPrompts: Readonly<Record<string, string>> =
  Object.freeze(
    Object.assign(Object.create(null) as Record<string, string>, {
      mssuzie: readFileSync(new URL('./mssuzie.md', import.meta.url), 'utf8'),
    }),
  );
