/**
 * buyer/src/ui/components/TaskRow.tsx — a single row in the task history table.
 */

import type { TaskRecord } from "../../sdk/types.js";

export interface TaskRowProps {
  task: TaskRecord;
}

function statusPillClass(status: TaskRecord["status"]): string {
  switch (status) {
    case "completed":
      return "bg-green-100 text-green-700";
    case "failed":
      return "bg-red-100 text-red-700";
    case "reclaimed":
      return "bg-yellow-100 text-yellow-700";
    default:
      return "bg-gray-200 text-gray-600";
  }
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

export default function TaskRow({ task }: TaskRowProps) {
  return (
    <tr data-testid="task-row" className="border-b border-gray-100">
      <td className="px-2 py-2 font-mono text-xs">{formatDate(task.posted_at)}</td>
      <td className="px-2 py-2 font-mono text-xs break-all">{task.supplier_pkh.slice(0, 16)}...</td>
      <td className="px-2 py-2 text-xs">{task.capability_id}</td>
      <td className="px-2 py-2">
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusPillClass(task.status)}`}>
          {task.status}
        </span>
      </td>
      <td className="px-2 py-2 text-xs text-gray-700">{task.prompt_preview}</td>
    </tr>
  );
}
