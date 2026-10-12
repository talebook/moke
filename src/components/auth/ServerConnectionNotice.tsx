import Link from 'next/link';

export function ServerConnectionNotice({ hasHydrated, serverUrl }: { hasHydrated: boolean; serverUrl: string }) {
  if (!hasHydrated) return <p role="status" className="text-sm mb-4">正在加载连接信息…</p>;
  if (serverUrl) return null;
  return (
    <div role="alert" className="bg-destructive/10 border border-destructive/30 text-destructive text-sm rounded-lg p-3 mb-4">
      连接信息已失效，请返回服务器列表重新连接。
      <Link href="/welcome" className="block mt-2 font-medium underline">返回服务器列表</Link>
    </div>
  );
}
