import { createContext } from '@/lib/common/io/context/create-context'
import { createItemAction } from '@/lib/items/actions/create-item-action'
import { listItems } from '@/lib/items/domain/list-items'

export default async function Home() {
  const ctx = await createContext(['prisma'])
  const items = await listItems(ctx)

  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="mb-1 text-2xl font-bold">Items</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Walking skeleton: route → server action → ctx → prisma → db → UI.
      </p>

      <form action={createItemAction} className="mb-6 flex gap-2">
        <input
          name="title"
          placeholder="New item…"
          className="flex-1 rounded border border-neutral-300 px-3 py-2"
        />
        <button type="submit" className="rounded bg-black px-4 py-2 font-medium text-white">
          Add
        </button>
      </form>

      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="rounded border border-neutral-200 bg-white px-3 py-2">
            {item.title}
          </li>
        ))}
        {items.length === 0 && (
          <li className="text-sm text-neutral-400">No items yet — add one above.</li>
        )}
      </ul>
    </main>
  )
}
