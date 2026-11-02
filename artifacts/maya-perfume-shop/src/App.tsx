import { useEffect, useState, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetAdminPasscodeStatus, useUnlockAdminPasscode } from '@workspace/api-client-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { LockKeyhole } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import AdminPanel from '@/pages/admin-panel';
import { Crown } from '@/components/store/brand';
import { Header } from '@/components/store/header';
import { BottomNav } from '@/components/store/bottom-nav';
import { Footer } from '@/components/store/footer';
import { StoreProvider, useStore } from '@/lib/store-context';
import Welcome from '@/pages/store/welcome';
import Home from '@/pages/store/home';
import Shop from '@/pages/store/shop';
import ProductPage from '@/pages/store/product';
import Wishlist from '@/pages/store/wishlist';
import Bag from '@/pages/store/bag';
import Checkout from '@/pages/store/checkout';
import InfoPage from '@/pages/store/info';
import RawMaterialsPage from '@/pages/store/raw-materials';
import RawMaterialDetailPage from '@/pages/store/raw-material-detail';
import ContactPage from '@/pages/store/contact';
import { recordNavigation } from '@/pages/store/use-back';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const seoOrigin = 'https://mayacolllection.com';
const staticSeo: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Maya Collection | Luxury Perfumes & Raw Materials',
    description: 'Discover Maya Collection fragrances and perfumery raw materials. Browse product details, images, and current prices.',
  },
  '/welcome': {
    title: 'Maya Collection | Luxury Perfumes & Raw Materials',
    description: 'Discover Maya Collection fragrances and perfumery raw materials. Browse product details, images, and current prices.',
  },
  '/collection': {
    title: 'Perfume Collection | Maya Collection',
    description: 'Browse Maya Collection perfumes by collection, fragrance family, and bottle size.',
  },
  '/raw-material': {
    title: 'Perfumery Raw Materials | Maya Collection',
    description: 'Explore published perfumery ingredients and raw materials from Maya Collection, with product details and current prices.',
  },
  '/contact': {
    title: 'Contact Maya Collection',
    description: 'Contact Maya Collection for store details, customer support, and perfume enquiries.',
  },
  '/faq': {
    title: 'Frequently Asked Questions | Maya Collection',
    description: 'Find answers to common Maya Collection questions about perfumes, orders, and customer support.',
  },
  '/shipping': {
    title: 'Shipping Information | Maya Collection',
    description: 'Read Maya Collection delivery information and service details.',
  },
  '/returns': {
    title: 'Returns Information | Maya Collection',
    description: 'Review Maya Collection return and exchange information.',
  },
  '/privacy': {
    title: 'Privacy Policy | Maya Collection',
    description: 'Read the Maya Collection privacy policy.',
  },
  '/terms': {
    title: 'Terms of Service | Maya Collection',
    description: 'Read the Maya Collection terms of service.',
  },
};

function StoreShell() {
  const [path] = useLocation();
  const { rtl, isError, products, t } = useStore();
  useEffect(() => { recordNavigation(); window.scrollTo({ top: 0 }); }, [path]);
  useEffect(() => {
    if (path.startsWith('/product/') || /^\/raw-material\/\d+$/.test(path)) return;
    const seo = staticSeo[path] ?? staticSeo['/'];
    const canonicalPath = path === '/welcome' ? '/' : path;
    const canonicalUrl = new URL(canonicalPath, seoOrigin).toString();
    const previousTitle = document.title;
    const changed: Array<{ element: HTMLMetaElement; previous: string | null; created: boolean }> = [];
    const setMeta = (attribute: 'name' | 'property', key: string, value: string) => {
      let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
      const created = !element;
      if (!element) {
        element = document.createElement('meta');
        element.setAttribute(attribute, key);
        document.head.append(element);
      }
      changed.push({ element, previous: element.getAttribute('content'), created });
      element.setAttribute('content', value);
    };
    document.title = seo.title;
    setMeta('name', 'description', seo.description);
    setMeta('property', 'og:title', seo.title);
    setMeta('property', 'og:description', seo.description);
    setMeta('property', 'og:url', canonicalUrl);
    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const canonicalCreated = !canonical;
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.append(canonical);
    }
    const previousCanonical = canonical.getAttribute('href');
    canonical.href = canonicalUrl;
    return () => {
      document.title = previousTitle;
      for (const item of changed.reverse()) {
        if (item.created) item.element.remove();
        else if (item.previous === null) item.element.removeAttribute('content');
        else item.element.setAttribute('content', item.previous);
      }
      if (canonicalCreated) canonical?.remove();
      else if (previousCanonical === null) canonical?.removeAttribute('href');
      else canonical?.setAttribute('href', previousCanonical);
    };
  }, [path]);
  if (path === '/welcome') return <main className="mc-store" dir={rtl ? 'rtl' : 'ltr'}><Welcome/></main>;
  if (path === '/' && !localStorage.getItem('maya-welcomed')) return <Redirect to="/welcome" replace/>;
  return <main className="mc-store" dir={rtl ? 'rtl' : 'ltr'}>
    <Header/>
    {isError && products.length > 0 && <div className="mc-alert" role="alert">{t('loadError')}</div>}
    <div className="mc-route" key={path}>
      <Switch>
        <Route path="/" component={Home}/>
        <Route path="/collection" component={Shop}/>
        <Route path="/product/:id" component={ProductPage}/>
        <Route path="/wishlist" component={Wishlist}/>
        <Route path="/bag" component={Bag}/>
        <Route path="/checkout" component={Checkout}/>
        <Route path="/about"><Redirect to="/" replace/></Route>
        <Route path="/raw-material/:sourceId" component={RawMaterialDetailPage}/>
        <Route path="/raw-material" component={RawMaterialsPage}/>
         <Route path="/contact" component={ContactPage}/>
        <Route path="/faq"><InfoPage label="faq" titleKey="faqTitle" bodyKey="faqBody"/></Route>
        <Route path="/shipping"><InfoPage label="shipping" titleKey="shippingTitle" bodyKey="shippingBody"/></Route>
        <Route path="/returns"><InfoPage label="returns" titleKey="returnsTitle" bodyKey="returnsBody"/></Route>
        <Route path="/privacy"><InfoPage label="privacy" titleKey="privacyTitle" bodyKey="privacyBody"/></Route>
        <Route path="/terms"><InfoPage label="terms" titleKey="termsTitle" bodyKey="termsBody"/></Route>
        <Route><NotFound/></Route>
      </Switch>
    </div>
    <Footer/>
    <BottomNav/>
  </main>;
}

function AdminGate() {
  const status = useGetAdminPasscodeStatus();
  const unlock = useUnlockAdminPasscode();
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const unlocked = status.data?.unlocked;
  const submit = async (e: FormEvent) => { e.preventDefault(); setError(''); try { await unlock.mutateAsync({ data: { passcode } }); await status.refetch(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Admin access could not be checked. Please try again.'); } };
  if (status.isLoading) return <div className="mc-admin-gate"><div className="mc-admin-gate-card is-loading" data-testid="state-admin-checking"><Crown className="mc-gate-crown"/><p>Checking private access</p></div></div>;
  if (status.isError) return <div className="mc-admin-gate"><div className="mc-admin-gate-card"><Crown className="mc-gate-crown"/><h1>Admin access unavailable</h1><p role="alert">The server could not check your access. Please try again.</p><button onClick={() => void status.refetch()} disabled={status.isFetching} data-testid="button-retry-admin-access">{status.isFetching ? 'Checking…' : 'Try again'}</button><Link href="/">Return to storefront</Link></div></div>;
  if (unlocked) return <AdminPanel/>;
  return <div className="mc-admin-gate"><form onSubmit={submit} className="mc-admin-gate-card">
    <Crown className="mc-gate-crown"/><span className="mc-kicker">MAYA COLLECTION · PRIVATE</span><h1>Admin access</h1><p>Enter your administrator passcode to continue.</p>
    <label htmlFor="admin-passcode"><LockKeyhole size={13}/> Passcode</label>
    <input id="admin-passcode" type="password" required value={passcode} onChange={(e) => setPasscode(e.target.value)} data-testid="input-admin-passcode"/>
    {error && <p role="alert" className="mc-gate-error">{error}</p>}
    <button disabled={unlock.isPending} data-testid="button-admin-unlock">{unlock.isPending ? 'Verifying' : 'Unlock panel'}</button>
    <Link href="/" data-testid="link-admin-store">Return to storefront</Link>
  </form></div>;
}

function App() {
  return <TooltipProvider><WouterRouter base={basePath}><ErrorBoundary><QueryClientProvider client={queryClient}>
    <Switch>
      <Route path="/admin" component={AdminGate}/>
      <Route><StoreProvider><StoreShell/></StoreProvider></Route>
    </Switch>
    <Toaster/>
  </QueryClientProvider></ErrorBoundary></WouterRouter></TooltipProvider>;
}
export default App;
