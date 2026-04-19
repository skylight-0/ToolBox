import { useEffect, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import SubViewHeader from "../../components/SubViewHeader";

type TodoViewProps = {
  onBack: () => void;
};

type TodoItem = {
  id: string;
  text: string;
  completed: boolean;
};

function TodoView({ onBack }: TodoViewProps) {
  const [todos, setTodos] = useState<TodoItem[]>(() => {
    try {
      const saved = localStorage.getItem("toolbox_todos");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [todoInput, setTodoInput] = useState("");
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [editingTodoText, setEditingTodoText] = useState("");

  useEffect(() => {
    localStorage.setItem("toolbox_todos", JSON.stringify(todos));
  }, [todos]);

  const addTodo = () => {
    if (!todoInput.trim()) return;
    setTodos((current) => [
      { id: Date.now().toString(), text: todoInput.trim(), completed: false },
      ...current,
    ]);
    setTodoInput("");
  };

  const toggleTodo = (id: string) => {
    if (editingTodoId === id) return;
    setTodos((current) =>
      current.map((item) =>
        item.id === id ? { ...item, completed: !item.completed } : item,
      ),
    );
  };

  const deleteTodo = (id: string, event: MouseEvent) => {
    event.stopPropagation();
    setTodos((current) => current.filter((item) => item.id !== id));
  };

  const startEditTodo = (id: string, text: string, event: MouseEvent) => {
    event.stopPropagation();
    setEditingTodoId(id);
    setEditingTodoText(text);
  };

  const saveEditTodo = () => {
    if (editingTodoId && editingTodoText.trim()) {
      setTodos((current) =>
        current.map((item) =>
          item.id === editingTodoId ? { ...item, text: editingTodoText.trim() } : item,
        ),
      );
    }
    setEditingTodoId(null);
    setEditingTodoText("");
  };

  const cancelEditTodo = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setEditingTodoId(null);
      setEditingTodoText("");
    }
  };

  return (
    <div className="sub-view">
      <SubViewHeader title="待办事项" onBack={onBack} />
      <div className="sub-view-content todo-container">
        <div className="todo-input-group">
          <input
            type="text"
            className="todo-input"
            placeholder="添加新待办，回车保存..."
            value={todoInput}
            onChange={(event) => setTodoInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && addTodo()}
          />
          <button className="todo-add-btn" onClick={addTodo}>
            添加
          </button>
        </div>
        <div className="todo-list">
          {todos.length === 0 && <div className="todo-empty">暂无待办事项，快去添加吧！</div>}
          {todos.map((todo) => (
            <div
              key={todo.id}
              className={`todo-item ${todo.completed ? "completed" : ""}`}
              onClick={() => toggleTodo(todo.id)}
            >
              <div className="todo-checkbox">
                {todo.completed && <span className="todo-check-icon">✓</span>}
              </div>
              {editingTodoId === todo.id ? (
                <input
                  autoFocus
                  className="todo-edit-input"
                  value={editingTodoText}
                  onChange={(event) => setEditingTodoText(event.target.value)}
                  onBlur={saveEditTodo}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveEditTodo();
                    cancelEditTodo(event);
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <>
                  <span className="todo-text">{todo.text}</span>
                  <button
                    className="todo-edit-btn"
                    onClick={(event) => startEditTodo(todo.id, todo.text, event)}
                    title="编辑"
                  >
                    ✏️
                  </button>
                  <button
                    className="todo-delete-btn"
                    onClick={(event) => deleteTodo(todo.id, event)}
                    title="删除"
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default TodoView;
