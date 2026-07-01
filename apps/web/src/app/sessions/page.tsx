import { WorkspacePage } from '../../components/workspace-page';

export const dynamic = 'force-dynamic';

export default async function SessionsPage(): Promise<JSX.Element> {
  return <WorkspacePage viewId="sessions" />;
}
