import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

await prisma.item.deleteMany()
await prisma.item.createMany({
  data: [{ title: 'Sharpen the saw' }, { title: 'Measure twice, cut once' }],
})

console.log('Seeded items ✓')
await prisma.$disconnect()
