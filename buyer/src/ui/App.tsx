/**
 * buyer/src/ui/App.tsx — router shell.
 *
 * Routes (all gated by <RequireAuth>):
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
import BookSummarizer from "./pages/BookSummarizer.js";
import { RequireAuth, useAuth } from "./state/AuthContext.js";

function SignOutButton() {
  const { signOut } = useAuth();
  return (
    <button
      type="button"
      onClick={() => { void signOut(); }}
      className="ml-auto text-sm text-gray-600 hover:text-gray-900 hover:underline"
    >
      Sign out
    </button>
  );
}

export default function App() {
  return (
    <RequireAuth>
      <div className="min-h-screen bg-gray-50 text-gray-900">
        <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6">
          <Link to="/" className="font-medium hover:underline">Dashboard</Link>
          <Link to="/book" className="font-medium hover:underline">Book Summarizer</Link>
          <Link to="/tasks" className="font-medium hover:underline">Tasks</Link>
          <Link to="/pending" className="font-medium hover:underline">Pending</Link>
          <Link to="/wallet" className="font-medium hover:underline">Wallet</Link>
          <SignOutButton />
        </nav>
        <main className="p-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/book" element={<BookSummarizer />} />
            <Route path="/tasks" element={<TaskHistory />} />
            <Route path="/pending" element={<PendingReceipts />} />
            <Route path="/wallet" element={<Wallet />} />
          </Routes>
        </main>
      </div>
    </RequireAuth>
  );
}
