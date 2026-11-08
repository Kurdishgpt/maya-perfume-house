---
name: Cosmetics catalog compatibility
description: How the cosmetics storefront represents beauty categories without changing the live Supabase product schema.
---

Keep beauty categories in the existing text category-family field and retain the current internal product type until the Supabase schema is explicitly inspected and migrated. Preserve each size row's product ID, SKU, price, and stock so existing cart and checkout validation remain valid.

**Why:** The live store contains real product and stock records, and the existing product category uses a constrained value set. A broad schema change or fabricated catalog would risk live checkout data.

**How to apply:** Before expanding product attributes or reclassifying inventory, verify the current Supabase schema and use approved product data. Do not overwrite live prices, images, or stock with placeholders.
