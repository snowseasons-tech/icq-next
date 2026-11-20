import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  
  const passwordHash =
    await bcrypt.hash("password123", 12);

  const user = await prisma.user.create({
    data: {
        username: "admin",
        email: "admin@icq.local",
        password: passwordHash
    }
  }).catch(async () => prisma.user.findUniqueOrThrow({ where: { email: "admin@icq.local" } }));

    await prisma.room.upsert({
        where: {
          id: "general-room"
        },
        update: {},
        create: {
          id: "general-room",
          name: "General"
        }
    });

    console.log(user);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
