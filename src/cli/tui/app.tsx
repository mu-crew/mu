// The dashboard shell (S1): header, one status line, and the exit keys. The
// four tabs, rows, viewport and filters are S2; this proves the lifecycle and
// the render path end to end. Plain text only: no ANSI inside <Text>.

import { Box, Text, useApp, useInput } from "ink";
import type { DashboardQuery, DashboardRuntime } from "./runtime.js";
import { useSnapshot } from "./use-snapshot.js";

export interface AppProps {
  runtime: DashboardRuntime;
  /** The workstream to start on (S2 picks the tab; S1 only shows it). */
  initialWorkstream?: string;
  /** Poll gap in ms; null loads once. */
  pollMs: number | null;
  query?: DashboardQuery;
}

const NO_QUERY: DashboardQuery = {};

export function App({ runtime, initialWorkstream, pollMs, query = NO_QUERY }: AppProps) {
  const { exit } = useApp();
  const state = useSnapshot(runtime, query, pollMs);
  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
  });

  const { snapshot } = state;
  const status = snapshot
    ? `${snapshot.workstreams.length} workstreams · ${snapshot.tasks.length} tasks · ${snapshot.agents.length} agents`
    : state.loading
      ? "loading…"
      : "no data";
  return (
    <Box flexDirection="column">
      <Text bold>mu dashboard{initialWorkstream ? ` · ${initialWorkstream}` : ""}</Text>
      <Text>{status}</Text>
      {state.error ? <Text color="red">error: {state.error}</Text> : null}
      {state.warnings.map((w) => (
        <Text key={w} color="yellow">
          sync: {w}
        </Text>
      ))}
      <Text dimColor>q/Esc quit</Text>
    </Box>
  );
}
