BUN ?= bun

.PHONY: install
install:
	$(BUN) install
	cd admin-ui && $(BUN) install && $(BUN) run build
	$(BUN) link
