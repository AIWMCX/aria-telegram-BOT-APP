import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RuntimeState = "UNCONFIGURED" | "READY" | "PAPER_RUNNING" | "PAUSED" | "STOPPED" | "DEGRADED" | "FAULTED";
interface PersistedRuntime { state: RuntimeState; updatedAt: string; }

export interface RuntimeOptions { stateFile: string; lockFile: string; }

export class CustomerRuntime {
  private lockHandle: Awaited<ReturnType<typeof open>> | null = null;
  constructor(private readonly options: RuntimeOptions) {}

  private async load(): Promise<PersistedRuntime> {
    try { return JSON.parse(await readFile(this.options.stateFile, "utf8")) as PersistedRuntime; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "UNCONFIGURED", updatedAt: new Date(0).toISOString() }; throw error; }
  }

  private async save(state: RuntimeState): Promise<void> {
    await mkdir(dirname(this.options.stateFile), { recursive: true });
    const temp = `${this.options.stateFile}.tmp-${process.pid}`;
    await writeFile(temp, JSON.stringify({ state, updatedAt: new Date().toISOString() } satisfies PersistedRuntime), { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.options.stateFile);
  }

  async acquire(): Promise<void> {
    if (this.lockHandle) return;
    await mkdir(dirname(this.options.lockFile), { recursive: true });
    try { this.lockHandle = await open(this.options.lockFile, "wx"); await this.lockHandle.writeFile(`${process.pid}\n`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("runtime already running"); throw error; }
  }

  async release(): Promise<void> {
    if (!this.lockHandle) return;
    await this.lockHandle.close(); this.lockHandle = null; await rm(this.options.lockFile, { force: true });
  }

  async status(): Promise<PersistedRuntime> { return this.load(); }
  async setup(): Promise<void> { await this.acquire(); const current = await this.load(); if (current.state === "UNCONFIGURED") await this.save("READY"); }
  async startPaper(): Promise<void> { await this.acquire(); const current = await this.load(); if (!["READY", "PAUSED", "STOPPED"].includes(current.state)) throw new Error(`cannot start from ${current.state}`); await this.save("PAPER_RUNNING"); }
  async pause(): Promise<void> { await this.acquire(); if ((await this.load()).state !== "PAPER_RUNNING") throw new Error("cannot pause unless paper is running"); await this.save("PAUSED"); }
  async stop(): Promise<void> { await this.acquire(); await this.save("STOPPED"); }
}
