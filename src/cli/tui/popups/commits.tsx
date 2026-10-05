// Commits popup (Shift+0 → `)`). Fullscreen lazygit-style project
// commit log with '/' filtering and Enter → VCS show drill.
//
// Uses the project-root backend (detectBackend(projectRoot)) so git,
// jj, and sl all work through the shared VcsBackend.showCommit seam.
// The popup never mutates: `y` yanks the backend-specific show command
// for the focused commit.

import { Box, Text } from "ink";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { type CommitSummary, detectBackend, type VcsBackendName } from "../../../vcs.js";
import { type ColumnSpec, contentWidthFromCols, layoutColumns, renderRow } from "../columns.js";
import { dispatchPopupKeyFromInk, type PopupAction, type PopupActionEnvelope } from "../keys.js";
import { runLazygitInteractive } from "../lazygit.js";
import { ListRow } from "../list-row.js";
import { usePopupInput } from "../popup-input.js";
import { PopupShell } from "../popup-shell.js";
import { runTuicrInteractive } from "../tuicr.js";
import { usePopupActionQueue } from "../use-popup-action-queue.js";
import { applyFilter, FilterPrompt, listViewport, usePopupFilter } from "../use-popup-filter.js";
import { useTerminalSize } from "../use-terminal-size.js";
import { DrillScrollView, useDrillKeymap } from "./drill.js";
import { applyCursor, centredVisibleSlice, clickedItem, isNavAction } from "./scroll.js";
import { loadShowPreservingBody } from "./show-loader.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  slowTickNonce: number;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  onFilterEditingChange?: (editing: boolean) => void;
  popupActions?: readonly PopupActionEnvelope[];
  onFooter?: (command: string, copied: boolean, tone?: "normal" | "info" | "error") => void;
  db: Db;
  workstream: string;
}

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // sha short
  { kind: "protect", align: "right" }, // relative time
  { kind: "protect", max: 18 }, // author
  { kind: "clip", min: 1 }, // subject
];

const DRILL_CHROME_ROWS = 7;

export function CommitsPopup({
  yank,
  onClose,
  snapshot,
  slowTickNonce,
  mode,
  onModeChange,
  onFilterEditingChange,
  popupActions,
  onFooter,
}: PopupProps): ReactElement {
  const { cols } = useTerminalSize();
  const contentWidth = contentWidthFromCols(cols);
  const viewport = usePopupViewport();
  const drillViewport = usePopupViewport(DRILL_CHROME_ROWS);
  const [cursor, setCursor] = useState(0);
  const [showText, setShowText] = useState("");
  const [showLoading, setShowLoading] = useState(false);
  const [showErr, setShowErr] = useState<string | null>(null);
  const [backendName, setBackendName] = useState<VcsBackendName | null>(
    snapshot?.commitsBackend ?? null,
  );
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });
  const rowsViewport = listViewport(viewport, flt);

  const sourceCommits = snapshot?.recentCommits ?? [];
  const commits = applyFilter(
    sourceCommits,
    flt.query,
    (c) => `${c.sha} ${c.subject} ${c.author} ${c.relTime}`,
  );
  const safeCursor = commits.length === 0 ? 0 : Math.min(cursor, commits.length - 1);
  const focused = commits[safeCursor];
  // Pin the drilled commit at Enter. Commits are newest-first, so a
  // new commit on the slow tick shifts every index; following the
  // cursor would switch the open `git show` to a different commit.
  const [drilledCommit, setDrilledCommit] = useState<CommitSummary | null>(null);
  const drillCommit = mode === "drill" ? (drilledCommit ?? focused) : focused;
  const showCommand =
    drillCommit && backendName !== null
      ? showCommandForBackend(backendName, drillCommit.sha)
      : null;
  const projectRoot = process.cwd();
  const showBody = showErr !== null ? `error: ${showErr}` : showText;

  const loadShow = useCallback(
    async (sha: string) => {
      await loadShowPreservingBody(
        projectRoot,
        sha,
        async (path) => {
          const backend = await detectBackend(path);
          setBackendName(backend.name);
          return backend;
        },
        {
          setText: setShowText,
          setError: setShowErr,
          setLoading: setShowLoading,
        },
      );
    },
    [projectRoot],
  );

  useEffect(() => {
    if (snapshot?.commitsBackend !== undefined) setBackendName(snapshot.commitsBackend);
  }, [snapshot?.commitsBackend]);

  useEffect(() => {
    if (mode !== "drill") {
      setShowText("");
      setShowErr(null);
      setShowLoading(false);
    }
  }, [mode]);

  const drillSha = drillCommit?.sha;
  useEffect(() => {
    void slowTickNonce;
    if (mode === "drill" && drillSha !== undefined) {
      void loadShow(drillSha);
    }
  }, [mode, drillSha, loadShow, slowTickNonce]);

  const drill = useDrillKeymap({
    body: showBody,
    viewport: drillViewport,
    onClose: () => {
      setDrilledCommit(null);
      onModeChange("list");
    },
    onYank: () => {
      if (showCommand !== null) return yank(showCommand);
    },
    onTuicr: () => {
      if (!drillCommit) return;
      const r = runTuicrInteractive({ rev: drillCommit.sha, cwd: projectRoot });
      if (!r.ok) onFooter?.(r.error ?? "tuicr failed", false, "error");
      else onFooter?.(`tuicr -r ${drillCommit.sha}`, true, "info");
    },
    resetKey: drillCommit?.sha ?? "",
  });

  const dispatchListAction = (action: PopupAction) => {
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (isNavAction(action)) {
      setCursor((c) => applyCursor(c, action, commits.length, rowsViewport));
      return;
    }
    switch (action.kind) {
      case "close":
        onClose();
        return;
      case "filter":
        flt.startEdit();
        return;
      case "drill": {
        if (!focused) return;
        setDrilledCommit(focused);
        onModeChange("drill");
        return;
      }
      case "clickRow": {
        const hit = clickedItem(commits, safeCursor, rowsViewport, action.row);
        if (!hit) return;
        setCursor(hit.index);
        setDrilledCommit(hit.item);
        onModeChange("drill");
        return;
      }
      case "yank": {
        const c = commits[safeCursor];
        if (!c || backendName === null) return;
        void yank(showCommandForBackend(backendName, c.sha));
        return;
      }
      case "verb":
        if (action.key === "l") {
          const r = runLazygitInteractive({ cwd: projectRoot });
          if (!r.ok) onFooter?.(r.error ?? "lazygit failed", false, "error");
          else onFooter?.("lazygit", true, "info");
        }
        return;
    }
  };

  usePopupActionQueue(popupActions, dispatchListAction);

  usePopupInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    dispatchListAction(dispatchPopupKeyFromInk(input, key));
  });

  if (snapshot === null) {
    return <PopupShell title="Commits · loading">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (mode === "drill" && drillCommit !== undefined) {
    const short = shortSha(drillCommit.sha);
    return (
      <PopupShell title={`Commits · ${formatBackend(backendName)} · ${short}`}>
        <Box flexDirection="column" flexGrow={1}>
          <DrillScrollView
            title={`${showCommand ?? "show"} · ${drillCommit.subject}`}
            body={showBody}
            viewport={drillViewport}
            scrollTop={drill.scrollTop}
            wrappedBody={drill.wrappedBody}
            hint={
              showCommand === null
                ? "y yanks show command · t tuicr"
                : `y yanks \`${showCommand}\` · t tuicr`
            }
            emptyText={showLoading ? "loading…" : "(empty show output)"}
          />
        </Box>
      </PopupShell>
    );
  }
  if (sourceCommits.length === 0) {
    return (
      <PopupShell title={`Commits · ${formatBackend(backendName)}`}>
        <Text dimColor>(no commits)</Text>
      </PopupShell>
    );
  }
  if (commits.length === 0) {
    return (
      <PopupShell title={`Commits · ${formatBackend(backendName)}`}>
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  const { visible } = centredVisibleSlice(commits, safeCursor, rowsViewport);
  const rows = visible.map((c) => [shortSha(c.sha), c.relTime, c.author, c.subject]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`Commits · ${formatBackend(backendName)} (${safeCursor + 1}/${commits.length})`}
      hint="y yanks VCS show command · l lazygit"
    >
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((c, i) => {
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const colors = [
            { color: "yellow" }, // sha
            { dimColor: true }, // relTime
            { dimColor: true }, // author
            undefined, // subject
          ];
          return (
            <ListRow
              key={c.sha}
              cells={padded}
              contentWidth={contentWidth}
              colors={colors}
              selected={commits.indexOf(c) === safeCursor}
            />
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </PopupShell>
  );
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function formatBackend(backend: VcsBackendName | null): string {
  return backend ?? "(no vcs)";
}

export function showCommandForBackend(backend: VcsBackendName, sha: string): string {
  switch (backend) {
    case "git":
      return `git show ${sha}`;
    case "jj":
      return `jj show ${sha}`;
    case "sl":
      return `sl show ${sha}`;
    case "none":
      return `# no VCS backend for commit ${sha}`;
  }
}

// Test-only helper: keeps the WorkstreamSnapshot import live under
// noUnusedLocals even when source-level tests import the prop type.
export function commitFilterBlob(c: CommitSummary): string {
  return `${c.sha} ${c.subject} ${c.author} ${c.relTime}`;
}
