import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export type SkillName = 'router' | 'knowledge-update';

export type Skill = {
  id: string;
  name: SkillName;
  version: number;
  prompt: string;
  schema: object;
  /** SHA-256 of the raw prompt.md bytes immediately followed by the raw schema.json bytes. */
  hash: string;
};

const cache = new Map<string, Skill>();

/** Loads a versioned skill from server/ai/skills. The hash covers the file bytes, not a re-serialization. */
export function loadSkill(name: SkillName, version = 1): Skill {
  const id = `${name}@${version}`;
  const cached = cache.get(id);
  if (cached) return cached;
  const directory = fileURLToPath(new URL(`./skills/${name}/v${version}/`, import.meta.url));
  const promptBytes = readFileSync(directory + 'prompt.md');
  const schemaBytes = readFileSync(directory + 'schema.json');
  const schema = JSON.parse(schemaBytes.toString('utf8')) as object;
  const hash = createHash('sha256').update(promptBytes).update(schemaBytes).digest('hex');
  const skill: Skill = {id, name, version, prompt: promptBytes.toString('utf8'), schema, hash};
  cache.set(id, skill);
  return skill;
}

export function loadBundledSkills() {
  return {router: loadSkill('router'), knowledgeUpdate: loadSkill('knowledge-update')};
}
