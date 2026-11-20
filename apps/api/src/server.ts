import prismaPackage from '@prisma/client';
import { buildApp } from './app.js';

const { PrismaClient } = prismaPackage as typeof import('@prisma/client');
const prisma = new PrismaClient();
const app = await buildApp({ prisma });

const start = async () => {
    const port = Number(process.env.PORT || 8000);
    await app.listen({ host: '0.0.0.0', port });

    console.log(`API running on :${port}`);
};

start();
