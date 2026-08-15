import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'
// Session/user shapes come from the backend adapter, so swapping the backend
// does not ripple type changes through the app.
export interface AuthUser {
  id: string
  email: string
}
export interface Session {
  user: AuthUser
}
import { supabase } from '../lib/supabaseClient'
import type { Profile } from '../types'

interface AuthContextValue {
  session: Session | null
  user: AuthUser | null
  profile: Profile | null
  loading: boolean
  /** profile.onboarded === false */
  needsOnboarding: boolean
  refreshProfile: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  async function loadProfile(userId: string) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()

    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[auth] loadProfile error:', error.message)
      return
    }

    if (data) {
      setProfile(data as Profile)
      return
    }

    // No profile row. The on_auth_user_created trigger normally creates it, so
    // this only happens if that migration has not been applied yet. Self-heal
    // rather than dropping the user onto Add with no local currency.
    const { data: created, error: insertError } = await supabase
      .from('profiles')
      .insert({ id: userId, onboarded: false })
      .select()
      .maybeSingle()

    if (insertError) {
      // eslint-disable-next-line no-console
      console.warn('[auth] could not create profile:', insertError.message)
      return
    }
    setProfile(created as Profile | null)
  }

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      if (data.session?.user) {
        await loadProfile(data.session.user.id)
      }
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange(
      async (_event, newSession) => {
        setSession(newSession)
        if (newSession?.user) {
          await loadProfile(newSession.user.id)
        } else {
          setProfile(null)
        }
        setLoading(false)
      },
    )

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      // Also treat a missing local currency as not-yet-onboarded: the Add page
      // depends on it for its default, so landing there without one is broken.
      needsOnboarding:
        !!session?.user &&
        profile !== null &&
        (!profile.onboarded || !profile.local_currency),
      refreshProfile: async () => {
        if (session?.user) await loadProfile(session.user.id)
      },
      signOut: async () => {
        await supabase.auth.signOut()
        setProfile(null)
        setSession(null)
      },
    }),
    [session, profile, loading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
