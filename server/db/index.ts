import { drizzle } from "drizzle-orm/node-postgres";

export const db = drizzle({
  connection: {
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 10_000,
    query_timeout: 15_000,
  },
});
