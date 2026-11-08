import { useEffect } from "react";
import { useGetRawMaterialBySourceId } from "@workspace/api-client-react";
import type { RawMaterial } from "@workspace/api-client-react";
import { Link, useParams } from "wouter";
import { FlaskConical, RefreshCw } from "lucide-react";
import { PageBar } from "@/components/store/header";
import { useStore } from "@/lib/store-context";
import { setProductPageMetadata } from "@/lib/product-seo";
import { useBack } from "@/pages/store/use-back";
import { MaterialCard } from "@/pages/store/raw-materials";

const productionOrigin = "https://mayacolllection.com";

export default function RawMaterialDetailPage() {
  const { sourceId: rawSourceId = "" } = useParams<{ sourceId: string }>();
  const sourceId = /^\d+$/.test(rawSourceId) ? Number(rawSourceId) : 0;
  const { t } = useStore();
  const back = useBack("/raw-material");
  const query = useGetRawMaterialBySourceId(sourceId, {
    query: { enabled: Number.isSafeInteger(sourceId) && sourceId > 0, staleTime: 5 * 60_000, retry: 1 },
  });
  const material = query.data;

  useEffect(() => material ? setProductPageMetadata({
    name: material.name,
    description: material.description,
    url: `${productionOrigin}/raw-material/${encodeURIComponent(String(material.source_id))}`,
    imageUrl: material.image_url,
    price: material.price,
    currency: material.currency,
    sku: material.source_sku,
    category: material.category,
    unitCode: material.unit === "g" ? "GRM" : undefined,
  }) : undefined, [material]);

  return <div className="mc-page" data-testid="page-raw-material-detail">
    <PageBar title={material?.name ?? t("rawMaterials")} onBack={back}/>
    {query.isLoading ? <div className="mc-raw-skel" aria-label="Loading raw material"/> :
      query.isError || !material ? <div className="mc-state" role={query.isError ? "alert" : undefined} data-testid="state-raw-material-detail-error">
        <FlaskConical size={22}/>
        <p>{query.isError ? "This raw material could not be loaded." : "This raw material is no longer available."}</p>
        {query.isError && <button className="mc-ghost-btn" onClick={() => void query.refetch()} data-testid="button-raw-detail-retry"><RefreshCw size={15}/> {t("retry")}</button>}
        <Link href="/raw-material" className="mc-ghost-btn">Browse raw materials</Link>
      </div> : <section className="mc-raw-detail-page">
        <p className="mc-kicker" dir="ltr">MAYA BEAUTY · {t("rawMaterialsKicker")}</p>
        <MaterialCard m={material} index={0} detailPageLink={false}/>
        <Link href="/raw-material" className="mc-raw-back-link">Browse all raw materials</Link>
      </section>}
  </div>;
}
