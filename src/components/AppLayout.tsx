import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import type { ReactNode } from 'react'

const navItems = [
  { to: '/add', label: 'Add' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/overview', label: 'Overview' },
]

export function AppLayout({ children }: { children: ReactNode }) {
  const { signOut, profile, user } = useAuth()
  const navigate = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate('/')
  }

  return (
    <div className="min-h-screen bg-surface text-ink">
      {/* Desktop sidebar — 220px fixed (Designer spec §7 Navigation) */}
      <aside className="fixed inset-y-0 left-0 hidden w-[220px] flex-col border-r border-line bg-surface px-3 py-5 md:flex">
        <div className="mb-6 px-2 text-lg font-semibold tracking-tight">
          Budget<span className="text-accent">Tracker</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex h-10 items-center rounded-sm px-3 text-sm font-medium ${
                  isActive
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-2 hover:bg-surface-2'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line pt-3">
          {user?.email && (
            <p className="truncate px-2 text-xs text-ink-3">{user.email}</p>
          )}
          {profile?.home_currency && (
            <p className="px-2 text-xs text-ink-3">
              Home: {profile.home_currency}
            </p>
          )}
          <button
            onClick={handleSignOut}
            className="mt-2 px-2 text-sm text-ink-2 hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar — 48px sticky (Designer spec) */}
      <header className="sticky top-0 z-10 flex h-12 items-center border-b border-line bg-surface px-4 md:hidden">
        <span className="text-base font-medium">
          Budget<span className="text-accent">Tracker</span>
        </span>
      </header>

      {/* Content */}
      <main className="md:ml-[220px]">
        <div className="mx-auto max-w-5xl px-4 py-6 pb-24 md:px-8 md:py-8 md:pb-8">
          {children}
        </div>
      </main>

      {/* Mobile bottom nav — 56px fixed, safe-area padding (Designer spec) */}
      <nav
        className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-surface md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex h-14 flex-1 flex-col items-center justify-center ${
                isActive ? 'text-accent' : 'text-ink-2'
              }`
            }
          >
            <span className="text-xs font-medium">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
