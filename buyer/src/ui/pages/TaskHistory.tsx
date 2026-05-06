/**
 * buyer/src/ui/pages/TaskHistory.tsx — task history list.
 */

import { useEffect, useState } from "react";
import { useMarketplace } from "../state/MarketplaceContext.js";
import TaskRow from "../components/TaskRow.js";
import type { TaskRecord } from "../../sdk/types.js";

export default function TaskHistory() {
  const marketplace = useMarketplace();
  const [tasks, setTasks] = useState<TaskRecord[]>([]);

  useEffect(() => {
    setTasks(marketplace.getTaskHistory());
  }, [marketplace]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      {tasks.length === 0 ? (
        <p className="text-gray-500">No tasks yet.</p>
      ) : (
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th className="px-2 py-2">Posted</th>
              <th className="px-2 py-2">Supplier</th>
              <th className="px-2 py-2">Capability</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Prompt</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <TaskRow key={t.escrow_ref} task={t} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
