/**
 * @fagaos/desktop-bridge — interface to the sandboxed desktop/browser plane.
 *
 * Per FAG-8 scope: interface only. The full design (Layer 4 isolation
 * under a separate OS user, agent-browser / Playwright control plane,
 * screen capture, clipboard/DnD boundaries) is in the FAG-4 deliverable
 * and is intentionally not implemented here.
 *
 * Anything that crosses into the desktop plane MUST:
 *   - run under a separate OS user (Layer 4 in docs/architecture.md §6)
 *   - hold a capability token scoped to a specific app + action
 *   - be logged in the audit log
 */

export interface DesktopAction {
  app: string;
  verb: 'click' | 'type' | 'read' | 'scroll' | 'capture' | 'shortcut' | 'paste';
  selector?: string;
  text?: string;
  keys?: ReadonlyArray<string>;
}

export interface DesktopResult {
  ok: boolean;
  /** Snippet of the affected region, base64 PNG, for confirmation. */
  previewPngBase64?: string;
  error?: { code: string; message: string };
}

export interface DesktopBridge {
  invoke(action: DesktopAction): Promise<DesktopResult>;
}

export const DESKTOP_BRIDGE_NOT_IMPLEMENTED =
  'Desktop/browser plane (FAG-4) ships the implementation. Phase 0 (FAG-8) defines the contract only.';
