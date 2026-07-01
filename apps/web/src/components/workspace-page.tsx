import { WorkspaceShell } from './workspace-shell';
import { getControlPlaneClient } from '../lib/api/client';
import { ControlPlaneHttpShellAdapter } from '../lib/shell/adapter';
import { loadWorkspaceShell, type WorkspaceViewId } from '@fagaos/workspace-shell';
import type { ReactNode } from 'react';

export interface WorkspacePageProps {
  viewId: WorkspaceViewId;
  children?: ReactNode;
}

/**
 * Convenience wrapper that loads the workspace shell snapshot for the
 * given view and renders the shell. Each top-level page delegates to
 * this component so the layout can stay simple and the active view
 * state stays in sync with the URL.
 */
export async function WorkspacePage({ viewId, children }: WorkspacePageProps): Promise<JSX.Element> {
  const adapter = new ControlPlaneHttpShellAdapter({ client: getControlPlaneClient() });
  const snapshot = await loadWorkspaceShell(adapter, { activeView: viewId });
  return <WorkspaceShell snapshot={snapshot}>{children}</WorkspaceShell>;
}
