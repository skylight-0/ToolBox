import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import SubViewHeader from "../../components/SubViewHeader";
import { notifyToolboxDataChanged } from "../../utils/dataSync";

type TodoViewProps = {
  onBack: () => void;
};

type TodoItem = {
  id: string;
  text: string;
  completed: boolean;
};

function TodoView({ onBack }: TodoViewProps) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todoInput, setTodoInput] = useState("");
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [editingTodoText, setEditingTodoText] = useState("");

  useEffect(() => {
    invoke<TodoItem[]>("get_todos")
      .then(setTodos)
      .catch(console.error);
  }, []);

  const persistTodos = (nextTodos: TodoItem[]) => {
    setTodos(nextTodos);
    void invoke("save_todos", { todos: nextTodos })
      .then(() => notifyToolboxDataChanged("todos"))
      .catch(console.error);
  };

  const addTodo = () => {
    if (!todoInput.trim()) return;
    persistTodos([
      { id: Date.now().toString(), text: todoInput.trim(), completed: false },
      ...todos,
    ]);
    setTodoInput("");
  };

  const toggleTodo = (id: string) => {
    if (editingTodoId === id) return;
    persistTodos(
      todos.map((item) =>
        item.id === id ? { ...item, completed: !item.completed } : item,
      ),
    );
  };

  const deleteTodo = (id: string, event: MouseEvent) => {
    event.stopPropagation();
    persistTodos(todos.filter((item) => item.id !== id));
  };

  const startEditTodo = (id: string, text: string, event: MouseEvent) => {
    event.stopPropagation();
    setEditingTodoId(id);
    setEditingTodoText(text);
  };

  const saveEditTodo = () => {
    if (editingTodoId && editingTodoText.trim()) {
      persistTodos(
        todos.map((item) =>
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
