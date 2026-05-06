/**
 * buyer/src/sdk/history.ts — TaskHistoryStore interface + two implementations.
 *
 * MemoryTaskHistoryStore       — in-memory (default for SDK + tests)
 * LocalStorageTaskHistoryStore — browser-side, JSON-encoded array under one key
 *
 * Records are returned ordered by posted_at DESCENDING. Filters apply additively.
 */

import type { TaskRecord, GetTaskHistoryOptions } from "./types.js";

const LOCAL_STORAGE_KEY = "marketplace:tasks";

export interface TaskHistoryStore {
  /** Persist a new or updated task record. Latest write wins on same escrow_ref. */
  save(record: TaskRecord): void;
  /** Get all records, ordered by posted_at descending, with optional filters. */
  list(opts?: GetTaskHistoryOptions): TaskRecord[];
  /** Get a single record by escrow_ref, or null if not found. */
  get(escrowRef: string): TaskRecord | null;
}

function applyFilters(records: TaskRecord[], opts?: GetTaskHistoryOptions): TaskRecord[] {
  if (!opts) return records;
  return records.filter((r) => {
    if (opts.status !== undefined && r.status !== opts.status) return false;
    if (opts.supplier !== undefined && r.supplier_pkh !== opts.supplier) return false;
    return true;
  });
}

function sortDesc(records: TaskRecord[]): TaskRecord[] {
  return [...records].sort((a, b) => b.posted_at - a.posted_at);
}

export class MemoryTaskHistoryStore implements TaskHistoryStore {
  private readonly records: Map<string, TaskRecord> = new Map();

  save(record: TaskRecord): void {
    this.records.set(record.escrow_ref, { ...record });
  }

  list(opts?: GetTaskHistoryOptions): TaskRecord[] {
    const all = Array.from(this.records.values());
    return sortDesc(applyFilters(all, opts));
  }

  get(escrowRef: string): TaskRecord | null {
    const r = this.records.get(escrowRef);
    return r ? { ...r } : null;
  }
}

/**
 * LocalStorageTaskHistoryStore — browser localStorage implementation.
 * All records live in a single JSON-encoded array under "marketplace:tasks"
 * to keep reads cheap and keep the API simple. Falls back to no-op if
 * localStorage is unavailable.
 */
export class LocalStorageTaskHistoryStore implements TaskHistoryStore {
  private readStorage(): TaskRecord[] {
    try {
      if (typeof globalThis === "undefined") return [];
      const ls = (globalThis as { localStorage?: Storage }).localStorage;
      if (!ls) return [];
      const raw = ls.getItem(LOCAL_STORAGE_KEY);
      if (raw === null) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as TaskRecord[]) : [];
    } catch {
      return [];
    }
  }

  private writeStorage(records: TaskRecord[]): void {
    try {
      if (typeof globalThis === "undefined") return;
      const ls = (globalThis as { localStorage?: Storage }).localStorage;
      if (!ls) return;
      ls.setItem(LOCAL_STORAGE_KEY, JSON.stringify(records));
    } catch {
      /* no-op — storage may be full or disabled */
    }
  }

  save(record: TaskRecord): void {
    const all = this.readStorage();
    const idx = all.findIndex((r) => r.escrow_ref === record.escrow_ref);
    if (idx >= 0) {
      all[idx] = { ...record };
    } else {
      all.push({ ...record });
    }
    this.writeStorage(all);
  }

  list(opts?: GetTaskHistoryOptions): TaskRecord[] {
    return sortDesc(applyFilters(this.readStorage(), opts));
  }

  get(escrowRef: string): TaskRecord | null {
    const all = this.readStorage();
    const r = all.find((x) => x.escrow_ref === escrowRef);
    return r ? { ...r } : null;
  }
}
