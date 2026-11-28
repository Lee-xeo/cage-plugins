# Service Preview

Use **Service Preview** in the Cage sidebar to open a web service started in the current environment.

1. Start an HTTP development server in a Cage terminal.
2. Open the preview page and find its port. The list refreshes every five seconds while visible.
3. Select **Open HTTP** to visit the service in the built-in browser.

Claude can use `service_preview_register` to add a label and an entry path such as `/docs` to a listening port. A registration stays in memory for the lifetime of its listener and the plugin process.

The list comes from the local TCP listener table. It includes services on the usual loopback addresses and wildcard listeners. TCP listeners may use protocols other than HTTP. The preview opens HTTP URLs and does not probe, start, stop, or forward services.

The plugin runs on Linux inside Cage and uses the Python 3 standard library.
