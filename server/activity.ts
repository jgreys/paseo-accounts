import { join } from "node:path";
import { z } from "zod";
import { SwitchRowSchema, type SwitchRow } from "../shared/timeline";
import { readJson, writeJsonAtomic } from "./json-file";
import { dataDir } from "./paths";

export const ActivityEntrySchema = z.object({
  agentId: z.string(),
  agentTitle: z.string().nullable(),
  row: SwitchRowSchema,
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

const KEEP = 300;
const activityPath = () => join(dataDir(), "switch-log.json");

/** Every account switch and every "stayed put" note, newest last, so the Activity tab can list them. */
export class ActivityLog {
  private entries: ActivityEntry[] | null = null;
  private saving: Promise<void> = Promise.resolve();

  async list(limit = 100): Promise<ActivityEntry[]> {
    return (await this.load()).slice(-limit).reverse();
  }

  async add(agentId: string, agentTitle: string | null, row: SwitchRow): Promise<void> {
    const entries = await this.load();
    entries.push({ agentId, agentTitle, row });
    if (entries.length > KEEP) entries.splice(0, entries.length - KEEP);
    this.saving = this.saving.then(() => writeJsonAtomic(activityPath(), entries)).catch(() => undefined);
    await this.saving;
  }

  private async load(): Promise<ActivityEntry[]> {
    if (this.entries) return this.entries;
    const saved = await readJson(activityPath()).catch(() => undefined);
    const parsed = z.array(ActivityEntrySchema).safeParse(saved);
    this.entries = parsed.success ? parsed.data : [];
    return this.entries;
  }
}
