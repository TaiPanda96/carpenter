"use server";

import { createContext } from "@/lib/common/create-context";
import { createItem } from "@/lib/items/domain/create-item";
import { revalidatePath } from "next/cache";

/**
 * Server Action = the boundary. Build the ctx here, delegate to the domain
 * function, revalidate. Keep boundary code thin; logic lives in /domain.
 */
export async function createItemAction(formData: FormData) {
  const title = String(formData.get("title") ?? "");

  const ctx = await createContext(["prisma"]);
  await createItem(ctx, { title, done: false });

  revalidatePath("/");
}
