# Original homepage artwork

Created with the built-in `image_gen` tool for the PetCareShop homepage, 28 October 2026.
These assets are original generated illustrations/photographs, not crops of the supplied UI reference.
Product photos and database content are unchanged.

The PNGs here are source assets; the browser receives only the smaller WebP files in
`public/images/home/` (approximately 187 KB combined). Rebuild them with:

```powershell
node scripts/optimize-home-images.mjs
```

The script uses the project's existing Playwright/Chrome installation and adds no packages.

Prompt briefs used with the built-in image tool (the exact prompts are recorded in [prompts.md](prompts.md)):

- `hero-pets.png`: Photorealistic golden retriever puppy and gray tabby kitten, dog left and kitten right, side by side on a fluffy ivory blanket, facing the camera. Bright powder-blue studio background, pets on the right half, clean blue negative space on the left for HTML copy, wide composition, soft light. No text, watermark, logos, or UI.
- `care-corgi.png`: Happy photorealistic corgi on the right of a compact wide banner, light sky-blue background, left half blank for HTML copy, soft studio light. No text, discounts, logos, or UI.
- `category-food.png`: Isolated polished illustration of a blue pet-food bowl full of brown kibble, subtle paw motif, soft dimensional studio lighting, transparent background, no text.
- `category-toys.png`: Isolated polished illustration of a colorful woven rope toy and ball, soft dimensional studio lighting, transparent background, no text.
- `category-accessories.png`: Isolated polished illustration of a red pet collar and small bone, soft dimensional studio lighting, transparent background, no text.
- `category-care.png`: Isolated polished illustration of a blue shampoo pump bottle with a smaller pink bottle, soft dimensional studio lighting, transparent background, no text.
- `category-supplements.png`: Isolated polished illustration of a yellow supplement jar with a turquoise lid and a few tablets, soft dimensional studio lighting, transparent background, no text.

Hotline/email follow the provided reference. Messenger and Zalo destination IDs were not supplied,
so those contact buttons clearly state that the channels are not configured.
No discount, review, sales-count, free-shipping, or service-policy claim is inferred from the reference.
