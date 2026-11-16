; Groovy: classes and `def`/typed functions and methods. A call names its
; function, or its method on a variable, `this` or a call's result (`obj.go()`,
; `new Widget().run()`), and a command call without parentheses (`println "hi"`)
; names its function too. A call through a capitalised class or a dotted path
; (`Collections.sort`, `java.util.Collections.sort`) names a class's method no
; name alone settles.
(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  function: (identifier) @name) @definition.function

(function_call
  function: (identifier) @name) @reference.call

(function_call
  function: (dotted_identifier
    .
    [(identifier) "this"] @receiver
    .
    (identifier) @name
    .)
  (#match? @receiver "^(this|[a-z_][A-Za-z0-9_]*)$")) @reference.call

(function_call
  function: (dotted_identifier
    .
    (function_call)
    .
    (identifier) @name
    .)) @reference.call

(juxt_function_call
  function: (identifier) @name) @reference.call
