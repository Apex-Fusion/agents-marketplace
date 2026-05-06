/**
 * buyer/src/ui/components/PiperTTSForm.tsx — capability-specific form
 * for `audio.synthesize.piper.v1` suppliers.
 *
 * The form posts directly to the buyer-app's `/v1/synth-speech` proxy,
 * which forwards to the openedai-speech-min PiperTTS host. Path B of the
 * multi-capability story: we render a Piper-shaped UI now (text + voice +
 * format + speed) without going through escrow. When the marketplace TTS-
 * supplier adapter lands, this same component is reused unchanged — only
 * the server endpoint swaps from /v1/synth-speech to a /v1/submit-tts.
 *
 * UX notes:
 *   - Voices and formats are hard-coded to what openedai-speech-min actually
 *     honours. If a future Piper deploy adds voices, expose them via a
 *     /v1/synth-speech-voices listing call instead of free-typing here.
 *   - We render a native <audio controls> on success so the user can play
 *     without leaving the page, plus a Download anchor whose href is the
 *     same blob URL (the audio buffer is materialised once and reused).
 *   - Blob URLs are revoked on unmount + on each new submit to avoid
 *     accumulating leaked memory across many demo runs.
 */

import { useEffect, useRef, useState } from "react";

const VOICES = [
  { value: "nova",    label: "Nova (default — feminine, warm)" },
  { value: "alloy",   label: "Alloy" },
  { value: "echo",    label: "Echo" },
  { value: "fable",   label: "Fable (British male)" },
  { value: "onyx",    label: "Onyx" },
  { value: "shimmer", label: "Shimmer" },
  { value: "lessac",  label: "Lessac (high-quality female)" },
] as const;

const FORMATS = [
  { value: "mp3",  label: "mp3" },
  { value: "wav",  label: "wav" },
  { value: "opus", label: "opus" },
  { value: "aac",  label: "aac" },
  { value: "flac", label: "flac" },
] as const;

interface AudioResult {
  blobUrl: string;
  format: string;
  byteLength: number;
}

export default function PiperTTSForm(): JSX.Element {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("nova");
  const [format, setFormat] = useState("mp3");
  const [speed, setSpeed] = useState(1.0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AudioResult | null>(null);

  // Track the active blob URL so we can revoke it before creating a new one
  // and on unmount. Without this, every successful synth leaks the previous
  // blob into the page until the user reloads.
  const activeBlobUrl = useRef<string | null>(null);
  useEffect(() => {
    return (): void => {
      if (activeBlobUrl.current) URL.revokeObjectURL(activeBlobUrl.current);
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (text.trim().length === 0) return;
    setLoading(true);
    setError(null);

    if (activeBlobUrl.current) {
      URL.revokeObjectURL(activeBlobUrl.current);
      activeBlobUrl.current = null;
    }
    setResult(null);

    try {
      const resp = await fetch("/v1/synth-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), voice, format, speed }),
      });
      if (!resp.ok) {
        // Try to parse JSON error; fall through to status text on non-JSON.
        let errMsg = `${resp.status} ${resp.statusText}`;
        try {
          const j = (await resp.json()) as { error?: string; message?: string };
          if (j.error || j.message) errMsg = `${j.error ?? "error"}: ${j.message ?? ""}`;
        } catch {
          /* keep status fallback */
        }
        throw new Error(errMsg);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      activeBlobUrl.current = url;
      setResult({ blobUrl: url, format, byteLength: blob.size });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded border border-gray-200 bg-white p-4"
      data-testid="piper-tts-form"
    >
      <div>
        <label className="block text-sm font-medium text-gray-700">
          Text to synthesize
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          maxLength={4000}
          placeholder="Type the words you want spoken…"
          className="mt-1 block w-full rounded border border-gray-300 p-2 text-sm focus:border-blue-500 focus:outline-none"
          data-testid="piper-tts-text"
        />
        <p className="mt-1 text-xs text-gray-500">{text.length} / 4000</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Voice</label>
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            className="mt-1 block w-full rounded border border-gray-300 p-2 text-sm"
            data-testid="piper-tts-voice"
          >
            {VOICES.map((v) => (
              <option key={v.value} value={v.value}>{v.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Format</label>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="mt-1 block w-full rounded border border-gray-300 p-2 text-sm"
            data-testid="piper-tts-format"
          >
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">
          Speed: <span className="font-mono">{speed.toFixed(2)}×</span>
        </label>
        <input
          type="range"
          min={0.5}
          max={1.5}
          step={0.05}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="mt-1 block w-full"
          data-testid="piper-tts-speed"
        />
        <div className="flex justify-between text-xs text-gray-500">
          <span>0.5×</span><span>1.0×</span><span>1.5×</span>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading || text.trim().length === 0}
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-400"
        data-testid="piper-tts-submit"
      >
        {loading ? "Synthesizing…" : "Generate audio"}
      </button>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
             data-testid="piper-tts-error">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2 rounded border border-green-300 bg-green-50 p-3"
             data-testid="piper-tts-result">
          <audio controls src={result.blobUrl} className="w-full" />
          <div className="flex items-center justify-between text-xs text-gray-700">
            <span>{(result.byteLength / 1024).toFixed(1)} KB · {result.format}</span>
            <a
              href={result.blobUrl}
              download={`speech.${result.format}`}
              className="rounded bg-gray-700 px-3 py-1 text-white hover:bg-gray-800"
              data-testid="piper-tts-download"
            >
              Download .{result.format}
            </a>
          </div>
        </div>
      )}
    </form>
  );
}
