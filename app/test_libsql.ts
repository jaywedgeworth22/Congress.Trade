import { createClient } from "npm:@libsql/client";
const client = createClient({ url: "file:test.db" });
client.execute("SELECT 1;").then(console.log).catch(console.error);
