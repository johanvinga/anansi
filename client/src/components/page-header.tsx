import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { PageBreadcrumbs, type PageBreadcrumbItem } from "./page-breadcrumbs";

interface PageHeaderProps {
  title: string;
  breadcrumbs: PageBreadcrumbItem[];
  actions?: ReactNode;
}

/** Title card shown at the top of every page, with breadcrumbs on the right. */
export function PageHeader({ title, breadcrumbs, actions }: PageHeaderProps) {
  return (
    <Card className="flex-row flex-wrap items-center justify-between gap-4 px-6 py-5">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {actions}
      </div>
      <PageBreadcrumbs items={breadcrumbs} />
    </Card>
  );
}
