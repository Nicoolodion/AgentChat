import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const createPrismaClient = () => {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Prisma client initialization.");
  }

  return new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: databaseUrl }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
};

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

let _prisma: PrismaClient | undefined;

function getPrismaInternal(): PrismaClient {
  if (!_prisma) {
    _prisma = global.prismaGlobal ?? createPrismaClient();
    if (process.env.NODE_ENV !== "production") {
      global.prismaGlobal = _prisma;
    }
  }
  return _prisma;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    try {
      const client = getPrismaInternal();
      return Reflect.get(client, prop, receiver);
    } catch (error) {
      throw new Error(
        `Prisma client initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});
