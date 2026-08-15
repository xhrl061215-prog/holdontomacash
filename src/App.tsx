import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { backendMode } from './lib/supabaseClient'
import { SetupNotice } from './components/SetupNotice'
import { AuthProvider, useAuth } from './context/AuthContext'
import { LoginPage } from './pages/LoginPage'
import { OnboardingPage } from './pages/OnboardingPage'
import { AddTransactionPage } from './pages/AddTransactionPage'
import { TransactionsPage } from './pages/TransactionsPage'
import { OverviewPage } from './pages/OverviewPage'
import { AppLayout } from './components/AppLayout'

function ProtectedRoutes() {
  const { user, loading, needsOnboarding } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-ink-3">
        Loading…
      </div>
    )
  }

  if (!user) {
    return <LoginPage />
  }

  if (needsOnboarding) {
    return <OnboardingPage />
  }

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<Navigate to="/add" replace />} />
        <Route path="/add" element={<AddTransactionPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="*" element={<Navigate to="/add" replace />} />
      </Routes>
    </AppLayout>
  )
}

export default function App() {
  // A deployed-but-unconfigured app should explain itself rather than failing at
  // sign-up with a message about API keys.
  if (backendMode === 'unconfigured') return <SetupNotice />

  return (
    <AuthProvider>
      <BrowserRouter>
        <ProtectedRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}
