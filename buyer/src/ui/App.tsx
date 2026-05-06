/**
 * buyer/src/ui/App.tsx — router shell.
 *
 * Routes:
 *   /         → <Dashboard />
 *   /tasks    → <TaskHistory />
 *   /pending  → <PendingReceipts />     UX-1: buyer-side Accept button
 *   /wallet   → <Wallet />
 */

import { Routes, Route, Link } from "react-router-dom";
import Dashboard from "./pages/Dashboard.js";
import TaskHistory from "./pages/TaskHistory.js";
import Wallet from "./pages/Wallet.js";
import PendingReceipts from "./pages/PendingReceipts.js";

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex gap-6">
        <Link to="/" className="font-medium hover:underline">Dashboard</Link>
        <Link to="/tasks" className="font-medium hover:underline">Tasks</Link>
        <Link to="/pending" className="font-medium hover:underline">Pending</Link>
        <Link to="/wallet" className="font-medium hover:underline">Wallet</Link>
      </nav>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks" element={<TaskHistory />} />
          <Route path="/pending" element={<PendingReceipts />} />
          <Route path="/wallet" element={<Wallet />} />
        </Routes>
      </main>
    </div>
  );
}
