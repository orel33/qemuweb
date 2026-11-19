# PDF versions of the Markdown documents, in docs/pdf/ (README.md, docs/*.md, test/tests.md and deploy/cremi/*.md).
# The style is docs/doc.css, the diagrams are the SVG
# files of docs/img/ referenced by the Markdown.
#   make docs                 rebuild the PDFs whose source, style or images changed
#   make docs/pdf/README.pdf  one document
#   make clean-docs           remove the PDFs
# Needs pandoc and google-chrome: see scripts/md2pdf.sh.
DOCS := README.md $(sort $(wildcard docs/*.md)) test/tests.md deploy/cremi/deploy-cremi.md deploy/cremi/cremi-architecture.md
PDFS := $(foreach f,$(DOCS),docs/pdf/$(basename $(notdir $(f))).pdf)
SHARED := docs/doc.css docs/doc.lua scripts/md2pdf.sh $(wildcard docs/img/*.svg docs/img/*.png)

.PHONY: docs clean-docs
docs: $(PDFS)

# Documents printed with a table of contents
TOC_DOCS := deploy/cremi/deploy-cremi.md

define PDF_RULE
docs/pdf/$(basename $(notdir $(1))).pdf: $(1) $(SHARED)
	./scripts/md2pdf.sh $(if $(filter $(1),$(TOC_DOCS)),--toc) $(1) $$@
endef
$(foreach f,$(DOCS),$(eval $(call PDF_RULE,$(f))))

clean-docs:
	rm -f $(PDFS)
