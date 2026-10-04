# GSTBill

A lightweight GST invoicing app built with HTML, CSS and JavaScript. The product catalogue ships in `product-data.js`, so it is available wherever the app is deployed. Bills are saved in browser-local IndexedDB; your business profile and in-progress draft use localStorage. No account or server database is involved.

## Start

Open this folder in VS Code and launch `index.html` with a static web server (for example, the Live Server extension). You can also open the page directly in a current Chrome or Edge browser; a local server is recommended so browser storage behaves consistently. No build step is required.

## Import your master list

1. In the billing screen select **Choose folder** and pick `C:\Users\Admin\Documents\MASTER UPLOAD`, or use **Import file** to select `420.xlsx` (or other Excel/CSV files).
2. The app reads the first worksheet of Excel files or the CSV header row. It recognizes common product, description, HSN/SAC, quantity, rate/price, and GST-rate column names. Imported rows appear in **Product library**.
3. In **Product library**, select **Save JS catalog** and choose this project's `product-data.js`, confirming replacement. Reload the app to use the saved catalog, then redeploy it to make the products available to everyone. If your browser doesn't support saving files directly, replace `product-data.js` with the downloaded file manually.
4. Excel import uses SheetJS from jsDelivr, so the browser needs an internet connection for `.xlsx`/`.xls`. CSV import works without that library. Browsers require a person to select the folder; a web page cannot silently read an absolute path from the computer.

## Create and print a bill

- Enter the business profile, invoice, and customer details; add line items or add products from the library.
- Enter unit rates before GST. Choose intra-state (CGST + SGST) or inter-state (IGST); tax is calculated from each item's GST rate.
- **Save bill & print** saves the invoice in the local database and opens the print dialog. Choose a 57 mm thermal paper width in the printer settings if your printer does not select it automatically.
- **Bill history** can open, reprint, or delete invoices. Browser data can be lost if site data is cleared, so use the browser's normal backup/export facilities where appropriate.

This is a local billing utility, not a GST return filing service. Verify invoice numbering, tax treatment, mandatory invoice fields, and printer setup for your business before issuing invoices.
