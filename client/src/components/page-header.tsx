import type { ReactNode } from "react";
import { PageBreadcrumbs, type PageBreadcrumbItem } from "./page-breadcrumbs";

interface PageHeaderProps {
  title: string;
  breadcrumbs: PageBreadcrumbItem[];
  actions?: ReactNode;
}

/** Title card shown at the top of every page, with breadcrumbs on the right. */
export function PageHeader({ title, breadcrumbs }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-4">
      <PageBreadcrumbs items={breadcrumbs} />
      {/* <Card className="flex-row flex-wrap items-center justify-between gap-4 px-6 py-5"> */}
      {/* <div className="flex flex-wrap items-center gap-4">
          {actions}
        </div> */}
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {/* </Card> */}
    </div>

  );
}
