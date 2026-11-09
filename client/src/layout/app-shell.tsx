import { useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  BookOpen,
  Boxes,
  ChevronsUpDown,
  ListTree,
  LogOut,
  Moon,
  Package,
  ScrollText,
  Sun,
  Tags,
  Truck,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { errorMessage } from "../api/client";
import type { CurrentUser } from "../api/types";
import { useAuth } from "../auth/auth-state";
import { ErrorAlert } from "../components/error-alert";
import { LanguageSwitcher } from "../i18n/language-switcher";
import { useTheme } from "./theme";

interface NavItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
}

const CATALOG_ITEMS: NavItem[] = [
  { to: "/suppliers", labelKey: "nav.suppliers", icon: Truck },
  { to: "/products", labelKey: "nav.products", icon: Package },
  { to: "/catalogs", labelKey: "nav.catalogs", icon: BookOpen },
  { to: "/attribute-sets", labelKey: "nav.attributeSets", icon: ListTree },
  { to: "/categories", labelKey: "nav.categories", icon: Tags },
];

const ADMIN_ITEMS: NavItem[] = [
  { to: "/users", labelKey: "nav.users", icon: Users },
  { to: "/audit", labelKey: "nav.auditLog", icon: ScrollText },
];

const ACCOUNT_ITEMS: NavItem[] = [{ to: "/account", labelKey: "nav.myAccount", icon: UserRound }];

function initials(user: CurrentUser): string {
  const source = user.displayName?.trim() || user.email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

interface NavGroupProps {
  label: string;
  items: NavItem[];
  pathname: string;
}

function NavGroup({ label, items, pathname }: NavGroupProps) {
  const { t } = useTranslation();
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="uppercase tracking-wide">{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const isActive = pathname === item.to || pathname.startsWith(`${item.to}/`);
            const label = t(item.labelKey);
            return (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton asChild isActive={isActive} tooltip={label}>
                  <Link to={item.to} aria-current={isActive ? "page" : undefined}>
                    <item.icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

interface UserMenuProps {
  user: CurrentUser;
  onLogout: () => void;
}

function UserMenu({ user, onLogout }: UserMenuProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
          <Avatar className="size-8 rounded-lg">
            <AvatarFallback className="rounded-lg">{initials(user)}</AvatarFallback>
          </Avatar>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{user.displayName ?? user.email}</span>
            <span className="truncate text-xs text-muted-foreground">{user.email}</span>
          </div>
          <ChevronsUpDown className="ml-auto size-4" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-56">
        <DropdownMenuLabel className="flex items-center justify-between gap-2 font-normal">
          <span className="truncate">{user.email}</span>
          <Badge variant={user.role === "admin" ? "default" : "secondary"}>{user.role}</Badge>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => navigate("/account")}>
            <UserRound />
            {t("nav.myAccount")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout}>
          <LogOut />
          {t("common.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [theme, setTheme] = useTheme();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const isAdmin = user?.role === "admin";

  if (!user) {
    return null;
  }

  async function handleLogout() {
    setLogoutError(null);
    try {
      await logout();
      navigate("/login", { replace: true });
    } catch (err) {
      setLogoutError(errorMessage(err));
    }
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link to="/suppliers">
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Boxes className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left leading-tight">
                    <span className="truncate font-semibold">{t("nav.appName")}</span>
                    <span className="truncate text-xs text-muted-foreground">{t("nav.appTagline")}</span>
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <NavGroup label={t("nav.catalog")} items={CATALOG_ITEMS} pathname={location.pathname} />
          {isAdmin ? <NavGroup label={t("nav.administration")} items={ADMIN_ITEMS} pathname={location.pathname} /> : null}
          <NavGroup label={t("nav.account")} items={ACCOUNT_ITEMS} pathname={location.pathname} />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <UserMenu user={user} onLogout={() => void handleLogout()} />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <span className="text-sm text-muted-foreground">{t("nav.headerTitle")}</span>
          <div className="ml-auto flex items-center gap-2">
            <LanguageSwitcher />
            <Button
              variant="ghost"
              size="icon"
              aria-label={theme === "dark" ? t("theme.switchToLight") : t("theme.switchToDark")}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>
        <main className="flex flex-1 flex-col gap-4 bg-muted/40 p-4 md:p-6">
          <ErrorAlert message={logoutError} />
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
