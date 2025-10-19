import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

try {
  const columns = await sql`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = 'products'
    AND column_name IN ('tags', 'shopify_variant_ids', 'image_urls')
    ORDER BY column_name
  `;

  console.log('\n=== Column Data Types ===');
  console.table(columns);

} catch (error) {
  console.error('Error:', error.message);
}

process.exit(0);
