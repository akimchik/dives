import { redirect } from "next/navigation";

type LoginPageProps = {
  searchParams?: Promise<{
    next?: string | string[];
  }>;
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function safeNextParam(value: string | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "";
  return `?next=${encodeURIComponent(value)}`;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  redirect(`/${safeNextParam(firstValue(params?.next))}`);
}
