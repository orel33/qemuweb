# PDF versions of the Markdown documents, in docs/pdf/ (README.md, docs/*.md, test/tests.md and deploy/cremi/install-cremi.md;
# docs/bak is an archive and is not built). The style is docs/doc.css, the diagrams are the SVG
# files of docs/img/ referenced by the Markdown.
#   make docs                 rebuild the PDFs whose source, style or images changed
#   make docs/pdf/README.pdf  one document
#   make clean-docs           remove the PDFs
# Needs pandoc and google-chrome: see scripts/md2pdf.sh.
DOCS := README.md $(sort $(wildcard docs/*.md)) test/tests.md deploy/cremi/install-cremi.md
PDFS := $(foreach f,$(DOCS),docs/pdf/$(basename $(notdir $(f))).pdf)
SHARED := docs/doc.css docs/doc.lua scripts/md2pdf.sh $(wildcard docs/img/*.svg docs/img/*.png)

.PHONY: docs clean-docs
docs: $(PDFS)

define PDF_RULE
docs/pdf/$(basename $(notdir $(1))).pdf: $(1) $(SHARED)
	./scripts/md2pdf.sh $(1) $$@
endef
$(foreach f,$(DOCS),$(eval $(call PDF_RULE,$(f))))

clean-docs:
	rm -f $(PDFS)
