; ReScript: a `let` bound to a function, and modules. An unqualified call or the
; right side of a pipe (`x->f`) names its function; `Belt.Array.map(...)` keeps
; its module path and stays unresolved rather than guessed.
(let_binding
  pattern: (value_identifier) @name
  body: (function)) @definition.function

(module_binding
  name: (module_identifier) @name) @definition.module

(call_expression
  function: (value_identifier) @name) @reference.call

(pipe_expression
  (value_identifier) @name
  .) @reference.call
