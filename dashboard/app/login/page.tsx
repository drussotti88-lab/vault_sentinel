export const dynamic = 'force-dynamic';

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string };
}) {
  const next = searchParams.next ?? '/';
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-2xl font-bold text-white">Sentinel</h1>
      <p className="mb-6 text-sm text-zinc-500">Enter your access code to manage watches.</p>

      <form method="POST" action="/api/login" className="space-y-3">
        <input type="hidden" name="next" value={next} />
        <input
          type="password"
          name="code"
          autoFocus
          required
          placeholder="Access code"
          aria-label="Access code"
          className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm text-white outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          Sign in
        </button>
      </form>

      {searchParams.error === '1' && (
        <p className="mt-3 text-sm text-red-400">Wrong access code. Try again.</p>
      )}
      {searchParams.error === 'notconfigured' && (
        <p className="mt-3 text-sm text-amber-400">
          No access code is configured. Set <code>DASHBOARD_ACCESS_CODE</code> in Vercel, then
          redeploy.
        </p>
      )}
    </main>
  );
}
