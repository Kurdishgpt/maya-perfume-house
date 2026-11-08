import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetSeoSummaryQueryKey,
  getListSeoCrawlsQueryKey,
  getListSeoRecordsQueryKey,
  useGetSeoSummary,
  useListSeoRecords,
  useListSeoCrawls,
  useStartSeoCrawl,
  useStepSeoCrawl,
  useUpdateSeoSettings,
} from "@workspace/api-client-react";
import type { ListSeoRecordsParams, SeoCrawlRun, SeoDiscoveryRecord } from "@workspace/api-client-react";
import {
  Activity, AlertCircle, AlertTriangle, ArrowDown, ArrowUpRight, Check, CheckCircle2, Clock3,
  ExternalLink, FileCode2, FileSearch, Globe2, Image, LoaderCircle, Package, Pause, Play,
  RefreshCw, Search, Settings2, ShieldCheck, Sparkles, XCircle,
} from "lucide-react";

const SITE_ORIGIN = "https://mayacolllection.com";
const SITEMAP_URL = "https://mayacolllection.com/sitemap.xml";
const PAGE_SIZE = 20;
const SEO_ISSUES = [
  "missing_or_generic_title", "duplicate_title", "missing_or_generic_description",
  "missing_canonical", "canonical_outside_site", "duplicate_canonical",
  "missing_product_structured_data", "missing_image_alt", "missing_product_image",
  "broken_internal_links", "http_error", "crawl_error", "noindex", "no_standalone_detail_page",
];
const baseInput = "h-10 rounded-md border border-white/10 bg-[#00272b] px-3 text-[11px] text-[#e8e5dd] outline-none transition-colors placeholder:text-[#69736f] focus:border-[#c7ad76]/60";
const panel = "rounded-lg border border-white/[.08] bg-[#023b40]/85";
const labelStyle = "text-[9px] font-semibold uppercase tracking-[.16em] text-[#84908a]";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed. Try again.";
}

function dateText(value?: string | null) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function compactDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function money(record: SeoDiscoveryRecord) {
  if (record.price === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: record.currency || "USD", maximumFractionDigits: 2 }).format(record.price);
}

function issueLabel(code: string) {
  return code.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function issueRecommendation(code: string) {
  const recommendations: Record<string, string> = {
    missing_or_generic_title: "Write a distinct, descriptive title for this page.",
    duplicate_title: "Give this page a title that differs from other pages.",
    missing_or_generic_description: "Add a concise, page-specific meta description.",
    missing_canonical: "Add a canonical tag that points to the preferred page URL.",
    canonical_outside_site: "Review the cross-site canonical; use a same-site canonical if this page is unique.",
    duplicate_canonical: "Choose one preferred URL and point duplicates to it.",
    missing_product_structured_data: "Add server-rendered Product structured data with the published price and availability.",
    missing_image_alt: "Add descriptive alt text to product images.",
    missing_product_image: "Publish a product image URL and provide meaningful alt text.",
    broken_internal_links: "Repair or remove links that lead to unsuccessful internal pages.",
    http_error: "Restore the page or remove it from internal links and the sitemap.",
    crawl_error: "Check the page response and retry the crawl.",
    noindex: "Confirm the noindex directive is intentional; remove it only if search visibility is desired.",
    no_standalone_detail_page: "This material has no unique detail URL; it is linked from the filtered materials listing.",
  };
  return recommendations[code] ?? "Review the crawl report and confirm this page should remain public and indexable.";
}

function StatusPill({ tone, children }: { tone: "good" | "warn" | "bad" | "quiet"; children: ReactNode }) {
  const styles = {
    good: "border-[#8eab8d]/25 bg-[#8eab8d]/10 text-[#bdd1b9]",
    warn: "border-[#d0ad61]/25 bg-[#d0ad61]/10 text-[#e5cd91]",
    bad: "border-[#cf8071]/25 bg-[#cf8071]/10 text-[#e5aaa0]",
    quiet: "border-white/10 bg-white/[.035] text-[#9aa39d]",
  };
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-[9px] font-medium ${styles[tone]}`}>{children}</span>;
}

function Skeleton() {
  return <div className="min-h-[100dvh] bg-[#002D32] p-5 text-[#e8e5dd]" data-testid="state-seo-loading">
    <div className="mx-auto max-w-[1500px] animate-pulse space-y-5">
      <div className="h-8 w-52 rounded bg-[#16474a]"/><div className="h-16 rounded-lg bg-[#16474a]"/>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[1,2,3,4].map((item)=><div className="h-24 rounded-lg bg-[#16474a]" key={item}/>)}</div>
      <div className="h-72 rounded-lg bg-[#16474a]"/>
    </div>
  </div>;
}

export default function SeoDiscovery() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [kind, setKind] = useState<ListSeoRecordsParams["kind"]>("all");
  const [sitemap, setSitemap] = useState<ListSeoRecordsParams["sitemap"]>("all");
  const [issue, setIssue] = useState("");
  const [page, setPage] = useState(1);
  const [crawlRun, setCrawlRun] = useState<SeoCrawlRun | null>(null);
  const [polling, setPolling] = useState(false);
  const [crawlError, setCrawlError] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const stopLoop = useRef(false);
  const params = useMemo<ListSeoRecordsParams>(() => ({
    search: debouncedSearch || undefined,
    kind: kind || "all",
    issue: issue || undefined,
    sitemap: sitemap || "all",
    page,
    per_page: PAGE_SIZE,
  }), [debouncedSearch, kind, issue, sitemap, page]);
  const summaryQuery = useGetSeoSummary({ query: { queryKey: getGetSeoSummaryQueryKey(), refetchInterval: polling ? 1800 : false } });
  const recordsQuery = useListSeoRecords(params, { query: { queryKey: getListSeoRecordsQueryKey(params) } });
  const historyQuery = useListSeoCrawls({ query: { queryKey: getListSeoCrawlsQueryKey(), refetchInterval: polling ? 1800 : false } });
  const startCrawl = useStartSeoCrawl();
  const stepCrawl = useStepSeoCrawl();
  const updateSettings = useUpdateSeoSettings();
  const summary = summaryQuery.data;
  const records = recordsQuery.data;
  const history = historyQuery.data?.items ?? [];
  const refreshing = summaryQuery.isFetching || recordsQuery.isFetching || historyQuery.isFetching;

  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetSeoSummaryQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListSeoRecordsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListSeoCrawlsQueryKey() }),
    ]);
  };

  const runSteps = async (initial: SeoCrawlRun) => {
    let run = initial;
    setCrawlRun(run);
    setPolling(true);
    stopLoop.current = false;
    try {
      while (run.status === "running" && !stopLoop.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        if (stopLoop.current) break;
        run = await stepCrawl.mutateAsync({ id: run.id });
        setCrawlRun(run);
      }
      if (run.status !== "running") {
        setPolling(false);
        await refreshAll();
      }
    } catch (error) {
      setCrawlError(errorText(error));
      setPolling(false);
      await refreshAll();
    }
  };

  const beginCrawl = async () => {
    setCrawlError("");
    try {
      const existing = crawlRun?.status === "running" ? crawlRun : summary?.current_run;
      if (existing?.status === "running") {
        setCrawlRun(existing);
        await runSteps(existing);
        return;
      }
      const run = await startCrawl.mutateAsync();
      setCrawlRun(run);
      if (run.status === "running") await runSteps(run);
      else { setPolling(false); await refreshAll(); }
    } catch (error) {
      setCrawlError(errorText(error));
      setPolling(false);
    }
  };

  const pausePolling = () => {
    stopLoop.current = true;
    setPolling(false);
  };

  const toggleSchedule = async () => {
    if (!summary || updateSettings.isPending) return;
    setSettingsError("");
    try {
      await updateSettings.mutateAsync({ data: { scheduled_enabled: !summary.scheduled_enabled } });
      await queryClient.invalidateQueries({ queryKey: getGetSeoSummaryQueryKey() });
    } catch (error) { setSettingsError(errorText(error)); }
  };

  const issueOptions = SEO_ISSUES;
  const issueRecords = (records?.items ?? []).filter((record) => record.issue_codes.length > 0);
  const liveRun = crawlRun?.status === "running" ? crawlRun : summary?.current_run;
  const totalPages = Math.max(1, records?.pages ?? 1);
  const queryError = summaryQuery.error || recordsQuery.error || historyQuery.error;

  if (summaryQuery.isLoading || recordsQuery.isLoading || historyQuery.isLoading) return <Skeleton/>;
  if (queryError && !summary) return <div className="grid min-h-[70dvh] place-items-center bg-[#002D32] px-5 text-[#eee9df]" data-testid="state-seo-error">
    <div className="max-w-md text-center"><AlertTriangle className="mx-auto mb-4 text-[#d3b56f]" size={28}/><h1 className="font-serif text-3xl">Discovery is unavailable</h1><p className="mt-3 text-sm leading-6 text-[#a2aaa3]">{errorText(queryError)}</p><button onClick={() => { void summaryQuery.refetch(); void recordsQuery.refetch(); void historyQuery.refetch(); }} className="mt-6 rounded-md bg-[#D9AD45] px-5 py-3 text-[10px] font-semibold uppercase tracking-[.14em] text-[#172526]" data-testid="button-retry-seo">Try again</button></div>
  </div>;

  const metrics = [
    { title: "Pages discovered", count: summary?.pages_discovered ?? 0, icon: FileSearch, foot: "Public content pages" },
    { title: "Products", count: summary?.products_discovered ?? 0, icon: Package, foot: "Catalog detail pages" },
    { title: "Raw materials", count: summary?.raw_materials_discovered ?? 0, icon: Sparkles, foot: "Catalog entries · listing links" },
    { title: "Images", count: summary?.images_discovered ?? 0, icon: Image, foot: "Referenced image assets" },
  ];
  const listError = recordsQuery.isError;
  const pageCount = records?.pages ?? 1;
  const renderRow = (record: SeoDiscoveryRecord, index: number) => {
    const recordId = `${record.page_type}-${index}-${record.url}`;
    const hasIssue = record.issue_codes.length > 0;
    return <tr key={recordId} className="border-t border-white/[.055] align-top transition-colors hover:bg-white/[.025]" data-testid={`row-seo-record-${index}`}>
      <td className="px-3 py-3">
        <div className="flex min-w-[200px] items-start gap-3">
          <div className="h-11 w-10 shrink-0 overflow-hidden rounded border border-white/10 bg-[#002d31]">
            {record.image_urls[0] ? <img src={record.image_urls[0]} alt="" className="h-full w-full object-cover" loading="lazy"/> : <div className="grid h-full place-items-center text-[#73807a]"><Image size={15}/></div>}
          </div>
          <div className="min-w-0">
            <a href={record.url} target="_blank" rel="noreferrer" className="line-clamp-2 text-[11px] font-medium leading-4 text-[#e8e5dd] hover:text-[#e3c782]" data-testid={`link-seo-record-${index}`} title={record.title}>{record.title || "Untitled page"}<ExternalLink className="ml-1 inline-block text-[#8e9a93]" size={11}/></a>
            <p className="mt-1 truncate font-mono text-[9px] text-[#75837d]" title={record.url}>{record.url.replace(SITE_ORIGIN, "") || "/"}</p>
            <p className="mt-1 line-clamp-2 max-w-[250px] text-[9px] leading-4 text-[#8e9891]" title={record.description}>{record.description || "No meta description"}</p>
          </div>
        </div>
      </td>
      <td className="px-3 py-3"><span className="rounded border border-white/10 px-2 py-1 text-[9px] uppercase tracking-wide text-[#b8c0b8]">{record.page_type.replace("_", " ")}</span></td>
      <td className="px-3 py-3 text-[10px] tabular-nums text-[#c6c9c1]">{record.page_type === "product" ? money(record) : "—"}</td>
      <td className="px-3 py-3"><StatusPill tone={record.http_status === null ? "quiet" : record.http_status >= 400 ? "bad" : "good"}>{record.http_status === null ? "Unknown" : `${record.http_status} ${record.http_status < 400 ? "OK" : "Error"}`}</StatusPill></td>
      <td className="px-3 py-3"><div className="max-w-[170px] truncate font-mono text-[9px] text-[#9aa39d]" title={record.canonical_url}>{record.canonical_url || "—"}</div><div className="mt-1 text-[9px] text-[#77827c]">{record.canonical_url === record.url ? "Self-canonical" : "Canonical differs"}</div></td>
      <td className="px-3 py-3">{record.sitemap_included ? <StatusPill tone="good">Included</StatusPill> : <StatusPill tone="warn">Excluded</StatusPill>}</td>
      <td className="px-3 py-3">{hasIssue ? <div className="flex max-w-[165px] flex-wrap gap-1">{record.issue_codes.map((code) => <span key={code} className="rounded bg-[#a55248]/15 px-1.5 py-1 text-[9px] text-[#e3a89b]">{issueLabel(code)}</span>)}</div> : <span className="text-[10px] text-[#8eaa8b]">Clear</span>}</td>
    </tr>;
  };

  return <div className="min-h-[100dvh] bg-[#002D32] text-[#e8e5dd]" data-testid="seo-discovery">
    <div className="pointer-events-none fixed inset-0 z-0 opacity-[.08]" style={{ backgroundImage: "radial-gradient(#c9b587 0.55px, transparent 0.55px)", backgroundSize: "18px 18px" }}/>
    <div className="relative z-10 mx-auto max-w-[1500px] px-4 py-6 md:px-8 md:py-9">
      <header className="flex flex-col justify-between gap-5 border-b border-white/[.08] pb-6 md:flex-row md:items-end">
        <div>
          <p className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[.22em] text-[#c3a769]"><Globe2 size={13}/> Maya Beauty · Search operations</p>
          <h1 className="mt-2 font-serif text-[34px] leading-tight tracking-[-.02em] text-[#eee9df] md:text-[42px]" data-testid="heading-seo-discovery">SEO discovery</h1>
          <p className="mt-2 max-w-2xl text-[12px] leading-5 text-[#939e97]">A clear view of public pages, crawl health and sitemap coverage. Storefront content stays untouched.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 hidden items-center gap-2 text-[10px] text-[#84908a] sm:flex"><span className={`h-1.5 w-1.5 rounded-full ${liveRun ? "animate-pulse bg-[#d9b457]" : "bg-[#8da58d]"}`}/>{liveRun ? "Crawl in progress" : "Discovery standing by"}</span>
          <button onClick={() => void (refreshAll())} disabled={refreshing} className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 px-3 text-[10px] uppercase tracking-[.1em] text-[#c4c9c2] transition-colors hover:bg-white/[.05] disabled:opacity-50" data-testid="button-refresh-seo"><RefreshCw size={13} className={refreshing ? "animate-spin" : ""}/> Refresh</button>
          {polling ? <button onClick={pausePolling} className="inline-flex h-10 items-center gap-2 rounded-md border border-[#d0ad61]/30 px-4 text-[10px] font-semibold uppercase tracking-[.1em] text-[#e2c67f] hover:bg-[#d0ad61]/10" data-testid="button-pause-crawl"><Pause size={13}/> Pause updates</button> : <button onClick={() => void beginCrawl()} disabled={startCrawl.isPending} className="inline-flex h-10 items-center gap-2 rounded-md bg-[#D9AD45] px-4 text-[10px] font-semibold uppercase tracking-[.1em] text-[#182526] transition-colors hover:bg-[#F0D49A] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-start-crawl">{startCrawl.isPending ? <LoaderCircle size={14} className="animate-spin"/> : <Play size={13}/>} {startCrawl.isPending ? "Starting…" : liveRun?.status === "running" ? "Resume updates" : "Run crawl"}</button>}
        </div>
      </header>

      {queryError && <div role="alert" className="mt-4 flex items-start gap-3 rounded-md border border-[#bd7162]/25 bg-[#2a211f] px-4 py-3 text-[11px] text-[#f0d6cf]" data-testid="alert-seo-partial-error"><AlertCircle size={15} className="mt-0.5 shrink-0"/><span>Some discovery data could not be refreshed. {errorText(queryError)}</span><button onClick={() => { void summaryQuery.refetch(); void recordsQuery.refetch(); void historyQuery.refetch(); }} className="ml-auto underline underline-offset-2" data-testid="button-retry-seo-data">Retry</button></div>}
      {crawlError && <div role="alert" className="mt-4 flex items-center gap-2 rounded-md border border-[#bd7162]/25 bg-[#2a211f] px-4 py-3 text-[11px] text-[#f0d6cf]" data-testid="alert-crawl-error"><AlertCircle size={15}/><span>{crawlError}</span><button onClick={() => setCrawlError("")} className="ml-auto" aria-label="Dismiss crawl error" data-testid="button-dismiss-crawl-error"><XCircle size={15}/></button></div>}

      <section className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Discovery totals">
        {metrics.map(({ title, count, icon: Icon, foot }) => <article key={title} className={`${panel} p-4 md:p-5`} data-testid={`metric-seo-${title.toLowerCase().replaceAll(" ", "-")}`}>
          <div className="flex items-center justify-between"><span className={labelStyle}>{title}</span><Icon size={15} className="text-[#b7a271]"/></div>
          <div className="mt-3 flex items-end justify-between gap-2"><strong className="font-serif text-[30px] leading-none text-[#eee9df] tabular-nums" data-testid={`value-seo-${title.toLowerCase().replaceAll(" ", "-")}`}>{count.toLocaleString()}</strong><span className="text-right text-[9px] text-[#75817b]">{foot}</span></div>
        </article>)}
      </section>

      <section className="mt-4 grid gap-3 md:grid-cols-[1.3fr_1fr_1fr]">
        <article className={`${panel} p-4 md:p-5`} data-testid="card-crawl-health">
          <div className="flex items-center justify-between"><span className={labelStyle}>Latest crawl health</span><Activity size={15} className="text-[#b7a271]"/></div>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
            <div><p className="font-serif text-[26px] leading-none text-[#eee9df]">{(summary?.successful_urls ?? 0).toLocaleString()} <span className="font-sans text-[10px] text-[#89948e]">successful URLs</span></p><p className="mt-2 text-[10px] text-[#7e8983]">Last crawl · {dateText(summary?.last_crawl_at)}</p></div>
            <div className="flex gap-2"><StatusPill tone={(summary?.broken_links ?? 0) ? "bad" : "good"}>{summary?.broken_links ?? 0} broken</StatusPill><StatusPill tone={(summary?.crawl_errors ?? 0) ? "warn" : "good"}>{summary?.crawl_errors ?? 0} errors</StatusPill></div>
          </div>
          {liveRun && <div className="mt-4 rounded-md border border-[#d0ad61]/20 bg-[#d0ad61]/[.05] p-3" data-testid="status-crawl-progress">
            <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-[10px] font-medium text-[#e3ce99]"><LoaderCircle size={13} className="animate-spin"/> Crawl running</span><span className="font-mono text-[10px] text-[#b8a778]">{liveRun.urls_checked.toLocaleString()} checked</span></div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full w-1/3 animate-pulse rounded-full bg-[#d9ad45]"/></div>
            <p className="mt-2 text-[9px] text-[#919a90]">{liveRun.remaining_urls.toLocaleString()} URLs remaining · {liveRun.pages_discovered + liveRun.products_discovered + liveRun.raw_materials_discovered} discovered</p>
          </div>}
        </article>
        <article className={`${panel} p-4 md:p-5`} data-testid="card-search-console">
          <div className="flex items-center justify-between"><span className={labelStyle}>Search Console</span><ShieldCheck size={15} className="text-[#b7a271]"/></div>
          <div className="mt-3 flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#c9a96a]"/><strong className="text-[12px] font-semibold text-[#e5e1d6]">Not connected</strong></div>
          <p className="mt-2 text-[10px] leading-4 text-[#87928b]">Google indexing is unknown. No verified indexing data has been supplied.</p>
          <a href="https://search.google.com/search-console/sitemaps" target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-[10px] text-[#e0c77f] hover:text-[#f2dfa9]" data-testid="link-search-console">Open Search Console to submit the sitemap <ArrowUpRight size={12}/></a>
          {summary?.verified_indexed_pages !== null && summary?.verified_indexed_pages !== undefined && <p className="mt-2 text-[10px] text-[#c3d0bd]">Verified indexed pages: {summary.verified_indexed_pages.toLocaleString()}</p>}
        </article>
        <article className={`${panel} p-4 md:p-5`} data-testid="card-sitemap-status">
          <div className="flex items-center justify-between"><span className={labelStyle}>Sitemap publication</span><FileCode2 size={15} className="text-[#b7a271]"/></div>
          <p className="mt-3 text-[10px] text-[#87928b]">Last generated · <span className="text-[#c8ccc2]">{dateText(summary?.sitemap_generated_at)}</span></p>
          <a href={SITEMAP_URL} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-[10px] text-[#e0c77f] hover:text-[#f2dfa9]" data-testid="link-public-sitemap">Open live sitemap <ArrowUpRight size={12}/></a>
          <p className="mt-1 break-all font-mono text-[9px] text-[#78847d]">{SITEMAP_URL}</p>
        </article>
      </section>

      <section className={`${panel} mt-4 p-4 md:p-5`} data-testid="card-crawl-settings">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-start gap-3"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[#c7ad76]/20 bg-[#c7ad76]/[.06] text-[#c7ad76]"><Settings2 size={16}/></div><div><h2 className="text-[12px] font-medium text-[#deddd4]">Scheduled discovery</h2><p className="mt-1 text-[10px] leading-4 text-[#87928b]">Automatically keep public page records and sitemap coverage current.</p><p className="mt-1 text-[9px] text-[#6f7c75]">Site origin · <a href={SITE_ORIGIN} target="_blank" rel="noreferrer" className="font-mono text-[#b7a271] hover:underline" data-testid="link-site-origin">{SITE_ORIGIN}</a></p></div></div>
          <button onClick={() => void toggleSchedule()} disabled={updateSettings.isPending} aria-pressed={!!summary?.scheduled_enabled} className={`inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-[10px] font-semibold uppercase tracking-[.1em] transition-colors disabled:opacity-50 ${summary?.scheduled_enabled ? "border-[#8eab8d]/30 bg-[#8eab8d]/10 text-[#bdd1b9]" : "border-white/10 text-[#bac0b8] hover:bg-white/[.04]"}`} data-testid="button-toggle-schedule">{updateSettings.isPending ? <LoaderCircle size={13} className="animate-spin"/> : summary?.scheduled_enabled ? <Check size={13}/> : <Clock3 size={13}/>} {summary?.scheduled_enabled ? "Schedule enabled" : "Schedule paused"}</button>
        </div>
        {settingsError && <p role="alert" className="mt-3 text-[10px] text-[#e5aaa0]" data-testid="alert-settings-error">{settingsError}</p>}
      </section>

      <section className={`${panel} mt-6 overflow-hidden`} data-testid="section-discovered-records">
        <div className="flex flex-col gap-4 border-b border-white/[.07] p-4 md:p-5">
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end"><div><p className={labelStyle}>Public inventory</p><h2 className="mt-1 font-serif text-[23px] text-[#e9e5da]">Discovered pages</h2><p className="mt-1 text-[10px] text-[#77837d]" data-testid="text-seo-record-count">Showing {records?.items.length ?? 0} of {records?.total ?? 0} records</p></div><div className="flex items-center gap-2 text-[9px] text-[#7d8982]"><span className="h-1.5 w-1.5 rounded-full bg-[#8da58d]"/>{refreshing ? "Updating records" : "Read-only catalog view"}</div></div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_180px_180px_200px]">
            <label className="relative"><span className="sr-only">Search discovered pages</span><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#76827c]"/><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className={`${baseInput} w-full pl-9`} placeholder="Search title, URL or description" data-testid="input-seo-search"/></label>
            <select value={kind ?? "all"} onChange={(event) => { setKind(event.target.value as ListSeoRecordsParams["kind"]); setPage(1); }} aria-label="Filter by page type" className={baseInput} data-testid="select-seo-kind"><option value="all">All page types</option><option value="page">Pages</option><option value="product">Products</option><option value="raw_material">Raw materials</option></select>
            <select value={sitemap ?? "all"} onChange={(event) => { setSitemap(event.target.value as ListSeoRecordsParams["sitemap"]); setPage(1); }} aria-label="Filter by sitemap inclusion" className={baseInput} data-testid="select-seo-sitemap"><option value="all">Any sitemap status</option><option value="included">Included in sitemap</option><option value="excluded">Excluded from sitemap</option></select>
            <select value={issue} onChange={(event) => { setIssue(event.target.value); setPage(1); }} aria-label="Filter by issue" className={baseInput} data-testid="select-seo-issue"><option value="">All issue states</option>{issueOptions.map((code) => <option key={code} value={code}>{issueLabel(code)}</option>)}</select>
          </div>
        </div>
        {listError ? <div className="flex min-h-48 flex-col items-center justify-center px-5 text-center" data-testid="state-seo-records-error"><AlertTriangle className="text-[#d3b56f]" size={22}/><p className="mt-3 text-[12px] text-[#ddd9cf]">Records could not be loaded.</p><p className="mt-1 max-w-md text-[10px] text-[#8b9690]">{errorText(recordsQuery.error)}</p><button onClick={() => void recordsQuery.refetch()} className="mt-4 rounded border border-white/10 px-3 py-2 text-[9px] uppercase tracking-[.1em] text-[#d4c08e]" data-testid="button-retry-seo-records">Retry records</button></div>
          : records?.items.length ? <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1060px] border-collapse text-left"><thead className="bg-[#002d31]/80"><tr className="text-[9px] uppercase tracking-[.12em] text-[#89948d]"><th className="px-3 py-3 font-medium">Page / description</th><th className="px-3 py-3 font-medium">Type</th><th className="px-3 py-3 font-medium">Price</th><th className="px-3 py-3 font-medium">HTTP</th><th className="px-3 py-3 font-medium">Canonical</th><th className="px-3 py-3 font-medium">Sitemap</th><th className="px-3 py-3 font-medium">Issues</th></tr></thead><tbody>{records.items.map(renderRow)}</tbody></table>
            </div>
            <div className="flex flex-col justify-between gap-3 border-t border-white/[.07] px-4 py-3 sm:flex-row sm:items-center">
              <p className="text-[10px] text-[#7c8881]" data-testid="text-seo-page-info">Page {records.page} of {pageCount} · {records.total} records</p>
              <div className="flex items-center gap-2"><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || recordsQuery.isFetching} className="inline-flex h-8 items-center gap-1 rounded border border-white/10 px-2.5 text-[10px] text-[#b9c0b9] hover:bg-white/[.04] disabled:opacity-35" data-testid="button-seo-previous"><ArrowDown className="rotate-90" size={12}/> Previous</button><button onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages || recordsQuery.isFetching} className="inline-flex h-8 items-center gap-1 rounded border border-white/10 px-2.5 text-[10px] text-[#b9c0b9] hover:bg-white/[.04] disabled:opacity-35" data-testid="button-seo-next">Next <ArrowUpRight size={12}/></button></div>
            </div>
          </> : <div className="flex min-h-56 flex-col items-center justify-center px-5 text-center" data-testid="state-seo-records-empty"><div className="grid h-11 w-11 place-items-center rounded-full border border-[#c7ad76]/20 bg-[#c7ad76]/[.06] text-[#b7a271]"><FileSearch size={18}/></div><h3 className="mt-4 font-serif text-xl text-[#e8e4d9]">{debouncedSearch || issue || kind !== "all" || sitemap !== "all" ? "No matching pages" : "No discovered pages yet"}</h3><p className="mt-2 max-w-sm text-[10px] leading-5 text-[#818c87]">{debouncedSearch || issue || kind !== "all" || sitemap !== "all" ? "Adjust the search or filters to broaden this view." : "Run a crawl to discover public catalog URLs and assess sitemap coverage."}</p>{(debouncedSearch || issue || kind !== "all" || sitemap !== "all") && <button onClick={() => { setSearch(""); setDebouncedSearch(""); setKind("all"); setSitemap("all"); setIssue(""); setPage(1); }} className="mt-3 text-[9px] font-semibold uppercase tracking-[.12em] text-[#d2bd8e] hover:text-[#eee0bb]" data-testid="button-clear-seo-filters">Clear filters</button>}</div>}
      </section>

      <section className="mt-5 grid gap-4 xl:grid-cols-[1.1fr_.9fr]">
        <article className={`${panel} overflow-hidden`} data-testid="section-seo-issues">
          <div className="flex items-center justify-between border-b border-white/[.07] px-4 py-4"><div><p className={labelStyle}>Triage</p><h2 className="mt-1 font-serif text-[21px] text-[#e9e5da]">Page issues</h2></div><StatusPill tone={issueRecords.length ? "warn" : "good"}>{issueRecords.length} flagged on this page</StatusPill></div>
          {issueRecords.length ? <div className="divide-y divide-white/[.055]">{issueRecords.slice(0, 8).map((record, index) => <div key={`${record.url}-${index}`} className="flex items-start gap-3 px-4 py-3" data-testid={`row-seo-issue-${index}`}><AlertTriangle size={14} className="mt-0.5 shrink-0 text-[#d5a878]"/><div className="min-w-0 flex-1"><a href={record.url} target="_blank" rel="noreferrer" className="block truncate text-[10px] font-medium text-[#d8d9d1] hover:text-[#e0c77f]" data-testid={`link-seo-issue-${index}`}>{record.title || record.url}<ExternalLink className="ml-1 inline" size={10}/></a>{record.issue_codes.map((code) => <p key={code} className="mt-1 text-[9px] leading-4 text-[#9b8a75]"><strong className="font-medium text-[#d5b486]">{issueLabel(code)}:</strong> {issueRecommendation(code)}</p>)}</div><StatusPill tone={record.sitemap_included ? "good" : "warn"}>{record.sitemap_included ? "In sitemap" : "Excluded"}</StatusPill></div>)}</div> : <div className="flex min-h-40 flex-col items-center justify-center px-5 text-center" data-testid="state-seo-issues-empty"><CheckCircle2 size={21} className="text-[#8eaa8b]"/><p className="mt-3 text-[11px] text-[#c3c9bf]">No flagged records in this page of results.</p><p className="mt-1 text-[9px] text-[#7e8983]">Use the issue filter to review known issue codes across pages.</p></div>}
        </article>
        <article className={`${panel} overflow-hidden`} data-testid="section-crawl-history">
          <div className="flex items-center justify-between border-b border-white/[.07] px-4 py-4"><div><p className={labelStyle}>Recent activity</p><h2 className="mt-1 font-serif text-[21px] text-[#e9e5da]">Crawl history</h2></div><Clock3 size={15} className="text-[#b7a271]"/></div>
          {history.length ? <div className="divide-y divide-white/[.055]">{history.slice(0, 6).map((run, index) => <div key={run.id} className="flex items-center justify-between gap-3 px-4 py-3" data-testid={`row-seo-crawl-${index}`}><div className="flex min-w-0 items-center gap-3"><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border ${run.status === "complete" ? "border-[#8eab8d]/25 bg-[#8eab8d]/10 text-[#a9c3a8]" : run.status === "failed" ? "border-[#cf8071]/25 bg-[#cf8071]/10 text-[#d28b7b]" : "border-[#d0ad61]/25 bg-[#d0ad61]/10 text-[#d8bd78]"}`}>{run.status === "complete" ? <Check size={14}/> : run.status === "failed" ? <XCircle size={14}/> : run.status === "running" ? <LoaderCircle className="animate-spin" size={14}/> : <AlertCircle size={14}/>}</span><div className="min-w-0"><p className="truncate text-[10px] font-medium capitalize text-[#d8dbd2]">{run.status} crawl {run.scheduled ? "· scheduled" : "· manual"}</p><p className="mt-1 text-[9px] text-[#7f8a83]">{dateText(run.started_at)}</p></div></div><div className="shrink-0 text-right"><p className="font-mono text-[10px] text-[#c6c9c1]">{run.urls_checked.toLocaleString()} URLs</p><p className="mt-1 text-[9px] text-[#79857e]">{run.broken_links} broken · {run.crawl_errors.length} errors</p></div></div>)}</div> : <div className="flex min-h-40 flex-col items-center justify-center px-5 text-center" data-testid="state-seo-history-empty"><Clock3 size={20} className="text-[#b7a271]"/><p className="mt-3 text-[11px] text-[#c3c9bf]">No crawl history yet.</p><p className="mt-1 text-[9px] text-[#7e8983]">A run will appear here after discovery begins.</p></div>}
        </article>
      </section>

      <footer className="mt-6 flex flex-col justify-between gap-2 border-t border-white/[.07] pt-4 text-[9px] text-[#69756f] sm:flex-row"><span>Discovery reads public catalog pages; this workspace does not edit storefront content.</span><span>Last sitemap generation · {compactDate(summary?.sitemap_generated_at)}</span></footer>
    </div>
  </div>;
}
