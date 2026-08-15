/**
 * Shown when the app is deployed but not yet connected to a database.
 *
 * Without this the failure surfaces as "Invalid API key" or a network error at
 * sign-up: a symptom that describes the mechanism rather than the cause, and gives
 * no hint that the fix is one file. An unconfigured deployment should say so.
 */
export function SetupNotice() {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <div className="max-w-lg border border-neutral-300 rounded p-6">
        <h1 className="text-lg font-medium text-neutral-900 mb-2">
          Almost there — one file to fill in
        </h1>
        <p className="text-sm text-neutral-600 mb-4">
          The app is deployed but not yet connected to a database, so there is
          nowhere to store accounts or transactions yet.
        </p>

        <ol className="text-sm text-neutral-700 space-y-2 mb-4 list-decimal pl-5">
          <li>
            Open <code className="bg-neutral-100 px-1 rounded">public/config.js</code>{' '}
            in the project.
          </li>
          <li>
            Replace the two placeholder values with your Supabase{' '}
            <strong>Project URL</strong> and <strong>anon public</strong> key, from
            Project Settings → API.
          </li>
          <li>Save and reload this page.</li>
        </ol>

        <p className="text-sm text-neutral-600">
          Use the <strong>anon public</strong> key, never{' '}
          <code className="bg-neutral-100 px-1 rounded">service_role</code> — that one
          bypasses the security rules that keep each person's data private.
        </p>

        <p className="text-xs text-neutral-500 mt-4">
          No rebuild is needed. Editing that file and reloading is enough.
        </p>
      </div>
    </div>
  )
}
