import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookOpen, Eye, History, Package, Pin, Share2, Trash2, Truck, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { apiRequest, errorMessage } from "../../api/client";
import type { DashboardSharedItem, PinDashboard, PinnedItemType, RecentCatalogView } from "../../api/types";
import { localize } from "../../api/translations";
import { formatDateTime } from "../../api/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { SearchForm } from "../../components/search-form";
import { SelectField } from "../../components/select-field";
import { ErrorAlert } from "../../components/error-alert";
import { ShareItemDialog } from "../../components/share-item-dialog";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { PageHeader } from "../../components/page-header";
import { usePagedList } from "../../lib/use-paged-list";

function itemPath(item: DashboardSharedItem) {
  if (item.itemType === "catalog") return `/catalogs/${item.itemId}/workspace`;
  if (item.itemType === "supplier") return `/suppliers/${item.itemId}`;
  return `/products/${item.itemId}`;
}

function ItemIcon({ type, className = "size-5" }: { type: PinnedItemType; className?: string }) {
  if (type === "catalog") return <BookOpen className={className} />;
  if (type === "supplier") return <Truck className={className} />;
  return <Package className={className} />;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = usePagedList();
  const { search } = list;
  const pinType = list.getFilter("pinType") as PinnedItemType | "";
  const shareType = list.getFilter("shareType") as PinnedItemType | "";
  const hidden = list.getFilter("hidden") as "" | "true" | "false";

  const [shareTarget, setShareTarget] = useState<{
    itemType: PinnedItemType;
    itemId: string;
    name: string;
    recipientIds: string[];
    note: string | null;
  } | null>(null);

  const dashboardQuery = useQuery({
    queryKey: ["pin-dashboard", { search, pinType, shareType, hidden }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (pinType) params.set("pinType", pinType);
      if (shareType) params.set("shareType", shareType);
      if (hidden) params.set("hidden", hidden);
      return apiRequest<PinDashboard>("GET", `/pins/dashboard?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  const recentCatalogsQuery = useQuery({
    queryKey: ["catalogs", "recent"],
    queryFn: () => apiRequest<{ items: RecentCatalogView[] }>("GET", "/catalogs/recent"),
  });

  async function unpin(item: DashboardSharedItem) {
    await apiRequest("DELETE", "/pins", { itemType: item.itemType, itemId: item.itemId });
    await queryClient.invalidateQueries({ queryKey: ["pin-dashboard"] });
  }

  async function setShareHidden(item: DashboardSharedItem, nextHidden: boolean) {
    const shareId = item.shareId;
    if (!shareId) return;
    await apiRequest("PATCH", `/shares/${shareId}`, { hidden: nextHidden });
    await queryClient.invalidateQueries({ queryKey: ["pin-dashboard"] });
  }

  async function revokeSent(item: DashboardSharedItem) {
    for (const recipient of item.recipients) {
      await apiRequest("DELETE", `/shares/${recipient.shareId}`);
    }
    await queryClient.invalidateQueries({ queryKey: ["pin-dashboard"] });
  }

  const dashboard = dashboardQuery.data;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("pins.dashboardTitle")} breadcrumbs={[{ label: t("pins.dashboardTitle") }]} />

      {dashboardQuery.error ? <ErrorAlert message={errorMessage(dashboardQuery.error)} /> : null}

      <Card className="gap-0 overflow-hidden py-0">
        <CardContent className="grid gap-3 p-4 md:grid-cols-3">
          {[
            { label: t("pins.sectionPins"), count: dashboard?.pins.total ?? 0, icon: Pin },
            { label: t("pins.sectionShared"), count: dashboard?.received.total ?? 0, icon: Users },
            { label: t("pins.sectionRecent"), count: dashboard?.sent.total ?? 0, icon: Share2 },
          ].map((stat) => (
            <div key={stat.label} className="flex items-center gap-3 rounded-lg border px-4 py-3">
              <div className="flex size-9 items-center justify-center rounded-md bg-muted">
                <stat.icon className="size-4" />
              </div>
              <div>
                <p className="text-2xl font-semibold leading-none tabular-nums">{dashboardQuery.isLoading ? "—" : stat.count}</p>
                <p className="mt-1 text-sm text-muted-foreground">{stat.label}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b p-4">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="size-4" />
              {t("pins.recentCatalogsTitle")}
            </CardTitle>
            <Badge variant="secondary">{recentCatalogsQuery.data?.items.length ?? 0}</Badge>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {recentCatalogsQuery.error ? <ErrorAlert message={errorMessage(recentCatalogsQuery.error)} /> : null}
          {recentCatalogsQuery.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : recentCatalogsQuery.data?.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("pins.recentCatalogsEmpty")}</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {recentCatalogsQuery.data?.items.map((catalog) => (
                <li key={catalog.id}>
                  <Link
                    to={`/catalogs/${catalog.id}/workspace`}
                    className="flex h-full items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted"><BookOpen className="size-4" /></div>
                    <div className="min-w-0 space-y-1">
                      <p className="line-clamp-2 text-sm font-medium">{catalog.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{catalog.supplierName ?? t("catalogs.unassigned")}</p>
                      <p className="text-xs text-muted-foreground">{t("pins.viewedAt", { date: formatDateTime(catalog.viewedAt) })}</p>
                      <Badge variant={catalog.analysisStatus === "failed" ? "destructive" : "secondary"}>
                        {t(`catalogs.analysisStatus.${catalog.analysisStatus}`)}
                      </Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="border-b p-4">
          <SearchForm
            label={t("pins.searchLabel")}
            placeholder={t("pins.searchPlaceholder")}
            value={list.searchInput}
            onChange={list.setSearchInput}
            onSearch={list.submitSearch}
          />
        </div>
        <div className="grid gap-3 p-4 md:grid-cols-3">
          <SelectField
            label={t("pins.pinType")}
            value={pinType}
            onChange={(value) => list.setFilter("pinType", value)}
            options={[
              { value: "", label: t("pins.allTypes") },
              { value: "catalog", label: t("pins.typeCatalog") },
              { value: "supplier", label: t("pins.typeSupplier") },
              { value: "product", label: t("pins.typeProduct") },
            ]}
          />
          <SelectField
            label={t("pins.sharedType")}
            value={shareType}
            onChange={(value) => list.setFilter("shareType", value)}
            options={[
              { value: "", label: t("pins.allTypes") },
              { value: "catalog", label: t("pins.typeCatalog") },
              { value: "supplier", label: t("pins.typeSupplier") },
              { value: "product", label: t("pins.typeProduct") },
            ]}
          />
          <SelectField
            label={t("pins.visibility")}
            value={hidden}
            onChange={(value) => list.setFilter("hidden", value)}
            options={[
              { value: "", label: t("pins.allShares") },
              { value: "false", label: t("pins.visibleShares") },
              { value: "true", label: t("pins.hiddenShares") },
            ]}
          />
        </div>
      </Card>

      {dashboardQuery.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {[0, 1, 2].map((column) => (
            <Card key={column} className="gap-3 py-4">
              <CardHeader><Skeleton className="h-5 w-32" /></CardHeader>
              <CardContent><Skeleton className="h-28 w-full" /></CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-3">
          <section className="min-w-0 space-y-3">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-base font-semibold">{t("pins.sectionPins")}</h2>
              <Badge variant="secondary">{dashboard?.pins.total ?? 0}</Badge>
            </div>
            {dashboard?.pins.items.length === 0 ? (
              <Empty className="min-h-64 border bg-card">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Pin /></EmptyMedia>
                  <EmptyTitle>{t("pins.emptyPins")}</EmptyTitle>
                </EmptyHeader>
                <EmptyContent className="max-w-none">
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button asChild variant="outline" size="sm"><Link to="/suppliers">{t("nav.suppliers")}</Link></Button>
                    <Button asChild variant="outline" size="sm"><Link to="/catalogs">{t("nav.catalogs")}</Link></Button>
                    <Button asChild variant="outline" size="sm"><Link to="/products">{t("nav.products")}</Link></Button>
                  </div>
                </EmptyContent>
              </Empty>
            ) : (
              <div className="space-y-3">
                {dashboard?.pins.items.map((item) => (
                  <Card key={`${item.itemType}-${item.itemId}`} className="gap-3 py-4 transition-transform hover:-translate-y-0.5">
                    <CardHeader className="pb-0">
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted"><ItemIcon type={item.itemType} /></div>
                        <div className="min-w-0">
                          <CardTitle className="line-clamp-2 text-base">{localize(item.name)}</CardTitle>
                          <CardDescription className="mt-1">{t(`pins.type.${item.itemType}`)}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {item.pinnedAt ? <p className="mb-3 text-xs text-muted-foreground">{formatDateTime(item.pinnedAt)}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        <Button asChild variant="outline" size="sm"><Link to={itemPath(item)}><Eye />{t("pins.open")}</Link></Button>
                        <Button variant="outline" size="sm" onClick={() => setShareTarget({ itemType: item.itemType, itemId: item.itemId, name: localize(item.name), recipientIds: [], note: null })}><Share2 />{t("pins.share")}</Button>
                        <Button variant="ghost" size="sm" onClick={() => void unpin(item)}><Pin className="fill-current" />{t("pins.unpin")}</Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <section className="min-w-0 space-y-3">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-base font-semibold">{t("pins.sectionShared")}</h2>
              <Badge variant="secondary">{dashboard?.received.total ?? 0}</Badge>
            </div>
            {dashboard?.received.items.length === 0 ? (
              <Empty className="min-h-64 border bg-card">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Users /></EmptyMedia>
                  <EmptyTitle>{t("pins.emptyShared")}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="space-y-3">
                {dashboard?.received.items.map((item) => (
                  <Card key={`${item.itemType}-${item.itemId}`} className="gap-3 py-4 transition-transform hover:-translate-y-0.5">
                    <CardHeader className="pb-0">
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted"><ItemIcon type={item.itemType} /></div>
                        <div className="min-w-0">
                          <CardTitle className="line-clamp-2 text-base">{localize(item.name)}</CardTitle>
                          <CardDescription className="mt-1">{item.sender?.displayName || item.sender?.email} · {t(`pins.type.${item.itemType}`)}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {item.note ? <p className="line-clamp-3 rounded-md bg-muted px-3 py-2 text-sm">{item.note}</p> : null}
                      {item.sharedAt ? <p className="text-xs text-muted-foreground">{formatDateTime(item.sharedAt)}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        <Button asChild variant="outline" size="sm"><Link to={itemPath(item)}><Eye />{t("pins.open")}</Link></Button>
                        <Button variant="outline" size="sm" onClick={() => void setShareHidden(item, !item.hidden)}>{item.hidden ? t("pins.restore") : t("pins.hide")}</Button>
                        <Button variant="outline" size="sm" onClick={() => setShareTarget({ itemType: item.itemType, itemId: item.itemId, name: localize(item.name), recipientIds: [], note: null })}><Share2 />{t("pins.reshare")}</Button>
                        <Button variant="outline" size="sm" onClick={async () => {
                          await apiRequest("POST", "/pins", { itemType: item.itemType, itemId: item.itemId });
                          await queryClient.invalidateQueries({ queryKey: ["pin-dashboard"] });
                        }}><Pin />{t("pins.pin")}</Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <section className="min-w-0 space-y-3">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-base font-semibold">{t("pins.sectionRecent")}</h2>
              <Badge variant="secondary">{dashboard?.sent.total ?? 0}</Badge>
            </div>
            {dashboard?.sent.items.length === 0 ? (
              <Empty className="min-h-64 border bg-card">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Share2 /></EmptyMedia>
                  <EmptyTitle>{t("pins.emptyRecent")}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="space-y-3">
                {dashboard?.sent.items.map((item) => (
                  <Card key={`${item.itemType}-${item.itemId}`} className="gap-3 py-4 transition-transform hover:-translate-y-0.5">
                    <CardHeader className="pb-0">
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted"><ItemIcon type={item.itemType} /></div>
                        <div className="min-w-0">
                          <CardTitle className="line-clamp-2 text-base">{localize(item.name)}</CardTitle>
                          <CardDescription className="mt-1">{item.recipients.map((recipient) => recipient.displayName || recipient.email).join(", ")}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {item.note ? <p className="line-clamp-3 rounded-md bg-muted px-3 py-2 text-sm">{item.note}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        <Button asChild variant="outline" size="sm"><Link to={itemPath(item)}><Eye />{t("pins.open")}</Link></Button>
                        <Button variant="outline" size="sm" onClick={() => setShareTarget({
                          itemType: item.itemType,
                          itemId: item.itemId,
                          name: localize(item.name),
                          recipientIds: item.recipients.map((recipient) => recipient.id),
                          note: item.note,
                        })}>{t("pins.editShare")}</Button>
                        <Button variant="destructive" size="sm" onClick={() => void revokeSent(item)}><Trash2 />{t("pins.revoke")}</Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {shareTarget ? (
        <ShareItemDialog
          open
          onOpenChange={(open) => !open && setShareTarget(null)}
          itemType={shareTarget.itemType}
          itemId={shareTarget.itemId}
          itemName={shareTarget.name}
          recipientIds={shareTarget.recipientIds}
          note={shareTarget.note}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ["pin-dashboard"] })}
        />
      ) : null}
    </div>
  );
}
