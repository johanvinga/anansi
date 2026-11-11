import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "./page-header";
import type { PageBreadcrumbItem } from "./page-breadcrumbs";

interface PageLayoutProps {
  title?: string;
  breadcrumbs?: PageBreadcrumbItem[];
  toolbar?: ReactNode;
  filters?: ReactNode;
  children: ReactNode;
}

export function PageLayout({ title, breadcrumbs, toolbar, filters, children }: PageLayoutProps) {
  return (
    <div className="flex flex-col gap-4">
      {title && breadcrumbs ? <PageHeader title={title} breadcrumbs={breadcrumbs} /> : null}
      {toolbar ? (
        <div className="flex flex-wrap items-center justify-between gap-3">{toolbar}</div>
      ) : null}
      <Card className="gap-0 py-0">
        {filters ? (
          <div className="flex flex-wrap items-center gap-1 border-b px-4 py-3">{filters}</div>
        ) : null}
        {children}
      </Card>
    </div>
  );
}
