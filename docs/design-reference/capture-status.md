# Figma reference capture

Source: https://www.figma.com/design/Gkx5ZvfH8wwuvt9hcxxFcE/でざいん?node-id=0-1

## Verified 2026-09-16

Native Figma now opens the design. Each screenshot was captured after selecting its named frame and using Zoom to selection; contact sheets were visually checked to exclude duplicate captures. 36 screen captures plus the original overview are stored here. Home is 402×874, background #F7F7F5. Phone hardware/status bars are reference chrome, not app UI.

Covered: home, login/signup, history, single/multiple transaction details, manual expense/income variants, receipt capture/review/analyzing/analysis/edit/result, analytics, expense/income/category/utility views, total assets, bank add/list, account/settings, categories, budget/goals, regular expenses, add transaction.

Some Figma frames share generic names. Filenames distinguish captures, not authoritative workflow order. In particular category-edit.png contains the category list, category-list.png contains the category edit form, and category-management.png contains the add form. Inspect the image when implementing.

`home-export.svg` contains the actual exported Home vectors for faithful icon extraction. The temporary export setting was removed after saving. No design content was changed.

Confirmed decisions from actual screens:
- Budget & Goals: monthly expense ceiling and monthly income target.
- Bank: manually registered accounts; no provider connection needed. User explicitly included bank, cash, and gift assets.
- Bottom navigation: Home, History, central Add, Analytics, Settings.

Figma MCP get_design_context/get_screenshot/get_metadata returned Unknown tool. Native application screenshots/export supplied the fallback references; no claim of structured MCP context retrieval.
