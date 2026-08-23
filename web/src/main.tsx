import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import '@/index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');

// No StrictMode: its double-invoked effects would open two pinned Postgres sessions per tab in dev.
createRoot(el).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
