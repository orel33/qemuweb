-- Pandoc filter for scripts/md2pdf.sh: a block quote that starts with a bold label becomes a
-- callout box, so that the Markdown stays a plain GitHub block quote:
--   > **Expect:** ...   > **Note:** ...   > **Warning:** ...
local classes = {Expect = 'expect', Note = 'note', Warning = 'warn'}

function BlockQuote(el)
  local first = el.content[1]
  if first and first.t == 'Para' and first.content[1] and first.content[1].t == 'Strong' then
    local label = pandoc.utils.stringify(first.content[1]):match('^(%a+)')
    local class = label and classes[label]
    if class then return pandoc.Div(el.content, pandoc.Attr('', {class})) end
  end
end
