import { useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRight, BookOpen, EyeOff, History, Eye, Pencil, Pin, Share2, Trash2, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { apiRequest, errorMessage } from "../../api/client";
import type { DashboardSharedItem, PinDashboard, PinnedItemType, RecentCatalogView, ShareUserSummary } from "../../api/types";
import { localize } from "../../api/translations";
import { formatDateShort } from "../../api/format";
import { Avatar, AvatarFallback } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { ErrorAlert } from "../../components/error-alert";
import { IconAction } from "../../components/icon-action";
import { SearchForm } from "../../components/search-form";
import { SelectField } from "../../components/select-field";
import { ShareItemDialog } from "../../components/share-item-dialog";
import { usePagedList } from "../../lib/use-paged-list";
import { DashboardRow, RecentCatalogCard, SharedEmptyState, StatCard } from "./dashboard-parts";

type ListTab = "pinned" | "sent";

function padCount(value: number): string {
  return String(value).padStart(2, "0");
}

interface ShareTarget {
  itemType: PinnedItemType;
  itemId: string;
  name: string;
  recipientIds: string[];
  note: string | null;
}

function userInitials(user: ShareUserSummary): string {
  const parts = (user.displayName?.trim() || user.email).split(/[\s@.]+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function DashboardPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = usePagedList();
  const { search } = list;
  const pinType = list.getFilter("pinType") as PinnedItemType | "";
  const shareType = list.getFilter("shareType") as PinnedItemType | "";
  const hidden = list.getFilter("hidden") as "" | "true" | "false";

  const [tab, setTab] = useState<ListTab>("pinned");
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const listsRef = useRef<HTMLDivElement>(null);

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

  const refreshDashboard = () => queryClient.invalidateQueries({ queryKey: ["pin-dashboard"] });

  async function unpin(item: DashboardSharedItem) {
    await apiRequest("DELETE", "/pins", { itemType: item.itemType, itemId: item.itemId });
    await refreshDashboard();
  }

  async function pin(item: DashboardSharedItem) {
    await apiRequest("POST", "/pins", { itemType: item.itemType, itemId: item.itemId });
    await refreshDashboard();
  }

  async function setShareHidden(item: DashboardSharedItem, nextHidden: boolean) {
    if (!item.shareId) return;
    await apiRequest("PATCH", `/shares/${item.shareId}`, { hidden: nextHidden });
    await refreshDashboard();
  }

  async function revokeSent(item: DashboardSharedItem) {
    for (const recipient of item.recipients) {
      await apiRequest("DELETE", `/shares/${recipient.shareId}`);
    }
    await refreshDashboard();
  }

  function showList(next?: ListTab) {
    if (next) setTab(next);
    listsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function shareItem(item: DashboardSharedItem, existing?: { recipientIds: string[]; note: string | null }) {
    setShareTarget({
      itemType: item.itemType,
      itemId: item.itemId,
      name: localize(item.name),
      recipientIds: existing?.recipientIds ?? [],
      note: existing?.note ?? null,
    });
  }

  const dashboard = dashboardQuery.data;
  const loading = dashboardQuery.isLoading;
  const pinnedCount = dashboard?.pins.total ?? 0;
  const receivedCount = dashboard?.received.total ?? 0;
  const sentCount = dashboard?.sent.total ?? 0;
  const count = (value: number) => (loading ? "—" : padCount(value));
  const typeOptions = [
    { value: "", label: t("pins.allTypes") },
    { value: "catalog", label: t("pins.typeCatalog") },
    { value: "supplier", label: t("pins.typeSupplier") },
    { value: "product", label: t("pins.typeProduct") },
  ];
  const recentCatalogs = recentCatalogsQuery.data?.items ?? [];
  const sentRecipients = (dashboard?.sent.items ?? [])
    .flatMap((item) => item.recipients)
    .filter((recipient, index, all) => all.findIndex((other) => other.id === recipient.id) === index)
    .slice(0, 2);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <p className="text-[11px] font-medium tracking-[0.2em] text-muted-foreground uppercase">{t("pins.eyebrow")}</p>
          <h1 className="text-3xl font-semibold tracking-tight">{t("pins.heroTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("pins.heroSubtitle")}</p>
        </div>
        <Button asChild size="lg">
          <Link to="/catalogs">
            <BookOpen />
            {t("pins.browseCatalogs")}
            <ArrowRight />
          </Link>
        </Button>
      </header>

      {dashboardQuery.error ? <ErrorAlert message={errorMessage(dashboardQuery.error)} /> : null}

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          featured
          icon={Pin}
          chipClassName="bg-transparent"
          title={t("pins.statPinned")}
          value={count(pinnedCount)}
          tagline={t("pins.statPinnedTagline")}
          footer={t("pins.statPinnedFooter")}
          onClick={() => showList("pinned")}
        />
        <StatCard
          icon={Users}
          chipClassName="bg-accent text-primary dark:text-foreground"
          title={t("pins.statReceived")}
          value={count(receivedCount)}
          tagline={t("pins.statReceivedTagline")}
          footer={
            <>
              <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
              {receivedCount === 0 ? t("pins.statReceivedFooterEmpty") : t("pins.statReceivedFooter")}
            </>
          }
          onClick={() => showList()}
        />
        <StatCard
          icon={Share2}
          chipClassName="bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
          title={t("pins.statSent")}
          value={count(sentCount)}
          tagline={t("pins.statSentTagline")}
          footer={
            <>
              {sentRecipients.length > 0 ? (
                <span className="flex -space-x-1.5">
                  {sentRecipients.map((recipient) => (
                    <Avatar key={recipient.id} className="size-6 ring-2 ring-card">
                      <AvatarFallback className="text-[9px]">{userInitials(recipient)}</AvatarFallback>
                    </Avatar>
                  ))}
                </span>
              ) : null}
              {sentCount === 0 ? t("pins.statSentFooterEmpty") : t("pins.statSentFooter")}
            </>
          }
          onClick={() => showList("sent")}
        />
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <History className="size-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">{t("pins.recentCatalogsTitle")}</h2>
            <Badge variant="secondary">{recentCatalogs.length}</Badge>
          </div>
          <Button asChild variant="link" size="sm" className="text-muted-foreground">
            <Link to="/catalogs">
              {t("pins.viewAllRecent")}
              <ArrowRight />
            </Link>
          </Button>
        </div>
        {recentCatalogsQuery.error ? <ErrorAlert message={errorMessage(recentCatalogsQuery.error)} /> : null}
        {recentCatalogsQuery.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-64 rounded-xl" />
            ))}
          </div>
        ) : recentCatalogs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("pins.recentCatalogsEmpty")}</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {recentCatalogs.map((catalog) => (
              <RecentCatalogCard key={catalog.id} catalog={catalog} onPinChange={() => void refreshDashboard()} />
            ))}
          </ul>
        )}
      </section>

      <section ref={listsRef} className="scroll-mt-20 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">{t("pins.workflowTitle")}</h2>
          <p className="text-xs text-muted-foreground">{t("pins.workflowHint")}</p>
        </div>

        <Card className="flex-row flex-wrap items-center gap-3 px-4 py-3">
          <SearchForm
            label={t("pins.searchLabel")}
            placeholder={t("pins.searchPlaceholder")}
            value={list.searchInput}
            onChange={list.setSearchInput}
            onSearch={list.submitSearch}
          />
          <div className="flex flex-wrap gap-2">
            <div className="w-40">
              <SelectField hideLabel label={t("pins.pinType")} value={pinType} onChange={(value) => list.setFilter("pinType", value)} options={typeOptions} />
            </div>
            <div className="w-40">
              <SelectField hideLabel label={t("pins.sharedType")} value={shareType} onChange={(value) => list.setFilter("shareType", value)} options={typeOptions} />
            </div>
            <div className="w-44">
              <SelectField
                hideLabel
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
          </div>
          <p className="ml-auto hidden text-xs text-muted-foreground xl:block">{t("pins.searchHint")}</p>
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          <Card className="gap-0 py-0">
            <Tabs value={tab} onValueChange={(value) => setTab(value as ListTab)} className="gap-0">
              <div className="flex h-12 items-center justify-between gap-3 border-b px-4">
                <TabsList variant="line" className="gap-5 p-0 group-data-horizontal/tabs:h-full">
                  <TabsTrigger value="pinned" className="h-full flex-none px-1 data-active:text-primary group-data-horizontal/tabs:after:bottom-[-1px] after:bg-primary">
                    <Pin />
                    {t("pins.sectionPins")}
                    <Badge variant="secondary">{loading ? "—" : pinnedCount}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="sent" className="h-full flex-none px-1 data-active:text-primary group-data-horizontal/tabs:after:bottom-[-1px] after:bg-primary">
                    <Share2 />
                    {t("pins.sectionSent")}
                    <Badge variant="secondary">{loading ? "—" : sentCount}</Badge>
                  </TabsTrigger>
                </TabsList>
                <span className="text-xs text-muted-foreground">{t("pins.recentlyAdded")}</span>
              </div>

              <TabsContent value="pinned">
                {loading ? (
                  <Skeleton className="m-4 h-40" />
                ) : dashboard?.pins.items.length === 0 ? (
                  <Empty className="min-h-64 border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><Pin /></EmptyMedia>
                      <EmptyTitle>{t("pins.emptyPins")}</EmptyTitle>
                      <EmptyDescription>{t("pins.emptyPinsHint")}</EmptyDescription>
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
                  <ul>
                    {dashboard?.pins.items.map((item) => (
                      <DashboardRow
                        key={`${item.itemType}-${item.itemId}`}
                        item={item}
                        subtitle={t(`pins.type.${item.itemType}`)}
                        date={item.pinnedAt ? formatDateShort(item.pinnedAt) : null}
                        actions={
                          <>
                            <IconAction label={t("pins.share")} icon={Share2} onClick={() => shareItem(item)} />
                            <IconAction label={t("pins.unpin")} icon={Pin} className="text-primary [&_svg]:fill-current" onClick={() => void unpin(item)} />
                          </>
                        }
                      />
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="sent">
                {loading ? (
                  <Skeleton className="m-4 h-40" />
                ) : dashboard?.sent.items.length === 0 ? (
                  <Empty className="min-h-64 border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><Share2 /></EmptyMedia>
                      <EmptyTitle>{t("pins.emptySent")}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <ul>
                    {dashboard?.sent.items.map((item) => (
                      <DashboardRow
                        key={`${item.itemType}-${item.itemId}`}
                        item={item}
                        subtitle={`${t(`pins.type.${item.itemType}`)} · ${item.recipients.map((recipient) => recipient.displayName || recipient.email).join(", ")}`}
                        date={item.sharedAt ? formatDateShort(item.sharedAt) : null}
                        note={item.note}
                        actions={
                          <>
                            <IconAction
                              label={t("pins.editShare")}
                              icon={Pencil}
                              onClick={() => shareItem(item, { recipientIds: item.recipients.map((recipient) => recipient.id), note: item.note })}
                            />
                            <IconAction label={t("pins.revoke")} icon={Trash2} destructive onClick={() => void revokeSent(item)} />
                          </>
                        }
                      />
                    ))}
                  </ul>
                )}
              </TabsContent>
            </Tabs>
          </Card>

          <Card className="gap-0 py-0">
            <div className="flex h-12 items-center justify-between gap-3 border-b px-4">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <Users className="size-4 text-muted-foreground" />
                {t("pins.sectionShared")}
              </h3>
              <Badge variant="secondary">{loading ? "—" : receivedCount}</Badge>
            </div>
            {loading ? (
              <Skeleton className="m-4 h-40" />
            ) : dashboard?.received.items.length === 0 ? (
              <SharedEmptyState />
            ) : (
              <ul>
                {dashboard?.received.items.map((item) => (
                  <DashboardRow
                    key={`${item.itemType}-${item.itemId}`}
                    item={item}
                    compact
                    subtitle={`${t("pins.fromSender", { name: item.sender?.displayName || item.sender?.email })} · ${t(`pins.type.${item.itemType}`)}`}
                    note={item.note}
                    actions={
                      <>
                        <IconAction
                          label={item.hidden ? t("pins.restore") : t("pins.hide")}
                          icon={item.hidden ? Eye : EyeOff}
                          onClick={() => void setShareHidden(item, !item.hidden)}
                        />
                        <IconAction label={t("pins.reshare")} icon={Share2} onClick={() => shareItem(item)} />
                        <IconAction label={t("pins.pin")} icon={Pin} onClick={() => void pin(item)} />
                      </>
                    }
                  />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </section>

      {shareTarget ? (
        <ShareItemDialog
          open
          onOpenChange={(open) => !open && setShareTarget(null)}
          itemType={shareTarget.itemType}
          itemId={shareTarget.itemId}
          itemName={shareTarget.name}
          recipientIds={shareTarget.recipientIds}
          note={shareTarget.note}
          onSaved={() => void refreshDashboard()}
        />
      ) : null}
    </div>
  );
}
